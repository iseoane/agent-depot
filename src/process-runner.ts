import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Receives a decoded chunk of a running child's output; chunks are not split on line boundaries. */
export type ChildOutputSink = (text: string, stream: "stdout" | "stderr") => void;

const childOutputSinks = new AsyncLocalStorage<ChildOutputSink>();

/**
 * Runs `work` so that every child started by `runProcess` inside it (however deep, whichever runner
 * a caller injected) also reports its output to `sink`. This is a read-only tap: capture, caps,
 * timeouts and results behave exactly as without a sink.
 */
export function withChildOutput<T>(sink: ChildOutputSink, work: () => Promise<T>): Promise<T> {
  return childOutputSinks.run(sink, work);
}

export interface ProcessRunOptions {
  readonly cwd?: string;
  /** Collect stdout instead of discarding it. */
  readonly captureStdout?: boolean;
  /**
   * With captureStdout, also show the captured stdout to the user. Captured stdout is normally
   * data for the caller (a version, a git object) and stays hidden; set this when it is the
   * command's own log, such as an App or Package lifecycle command.
   */
  readonly streamStdout?: boolean;
  /** With captureStdout, kill the process once stdout exceeds this many bytes. */
  readonly maxOutputBytes?: number;
  /** Cap stderr and kill the process if it exceeds this many bytes; otherwise uncapped. */
  readonly maxStderrBytes?: number;
  /** Kill a process that does not finish before this duration. */
  readonly timeoutMs?: number;
}

export interface ProcessRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly outputTooLarge: boolean;
  readonly timedOut?: boolean;
}

/** cmd.exe metacharacters, escaped with `^` (same set as cross-spawn). */
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;

/**
 * Characters that could chain commands or split the line if an npm cmd-shim's
 * `%*` re-parse flips quote parity; rejecting them prevents injection, though an
 * argument with `"` can still reach the program altered.
 */
const CMD_UNSAFE_ARGUMENT = /[\r\n&|<>]/u;

/** Quotes one argument for the MSVCRT parser: backslashes double only before a quote or the closing quote. */
function quoteMsvcrtArgument(argument: string): string {
  let encoded = "";
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    encoded += character === '"'
      ? `${"\\".repeat(backslashes * 2 + 1)}"`
      : `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `"${encoded}${"\\".repeat(backslashes * 2)}"`;
}

function escapeCmdArgument(argument: string, index: number): string {
  if (CMD_UNSAFE_ARGUMENT.test(argument)) {
    throw Object.assign(
      new Error(`Argument ${index} cannot be passed safely to a Windows batch file (line break or & | < > character)`),
      { code: "EINVAL" },
    );
  }
  return quoteMsvcrtArgument(argument).replace(CMD_META_CHARACTERS, "^$1");
}

/**
 * Windows cannot spawn a `.cmd`/`.bat` file without a shell (Node rejects it
 * since CVE-2024-27980), so it runs through `cmd.exe /d /s /c` with every
 * argument quoted and escaped; any other command is spawned directly. An
 * argument cmd.exe could misparse is rejected with `EINVAL`.
 */
export function spawnInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments: boolean } {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const line = [path.win32.normalize(command).replace(CMD_META_CHARACTERS, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * How long `runProcess` waits after asking a process (tree) to stop before it escalates (POSIX: SIGKILL)
 * or, once nothing more can be done, gives up on the stdio pipes a surviving descendant holds open.
 */
const KILL_GRACE_MS = 2_000;
/** Upper bound for the `ps` snapshot of the process tree. */
const PROCESS_LIST_TIMEOUT_MS = 1_000;

/**
 * Terminates a Windows child and everything it started. `child.kill()` ends
 * only the direct child, so for a batch file it would stop cmd.exe and leave
 * the real program running with the stdio pipes open; a program that starts
 * helpers has the same problem. Falls back to
 * `child.kill()` when taskkill cannot be started or fails (for example because
 * the child already exited). Never throws and does not wait for taskkill.
 */
function killWindowsProcessTree(child: ChildProcess): void {
  const { pid } = child;
  if (pid === undefined) {
    child.kill();
    return;
  }
  const taskkill = path.win32.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "taskkill.exe");
  try {
    spawn(taskkill, ["/pid", String(pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true })
      .on("error", () => { child.kill(); })
      .on("close", (code) => { if (code !== 0) child.kill(); });
  } catch {
    child.kill();
  }
}

/**
 * The pids of `rootPid` and every process descended from it, from a single `ps` snapshot. The child
 * stays in agent-depot's own process group and session (a detached group has no controlling terminal,
 * so a git or ssh prompt would fail, and a terminal Ctrl-C would no longer reach it), so a group kill
 * is not available. Never rejects: falls back to `rootPid` alone when `ps` cannot be run or read.
 */
function listProcessTree(rootPid: number): Promise<readonly number[]> {
  return new Promise((resolve) => {
    const tree = [rootPid];
    let ps: ChildProcess;
    try {
      ps = spawn("ps", ["-A", "-o", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"], timeout: PROCESS_LIST_TIMEOUT_MS });
    } catch {
      resolve(tree);
      return;
    }
    let output = "";
    ps.stdout?.setEncoding("utf8");
    ps.stdout?.on("data", (chunk: string) => { output += chunk; });
    // A missing `ps` is followed by `close` with no output, which leaves just the root.
    ps.on("error", () => {});
    ps.on("close", () => {
      const children = new Map<number, number[]>();
      for (const line of output.split("\n")) {
        const [pid, parent] = line.trim().split(/\s+/u).map(Number);
        if (pid === undefined || parent === undefined || !Number.isInteger(pid) || !Number.isInteger(parent)) continue;
        children.set(parent, [...(children.get(parent) ?? []), pid]);
      }
      for (const pid of tree) {
        for (const child of children.get(pid) ?? []) if (!tree.includes(child)) tree.push(child);
      }
      resolve(tree);
    });
  });
}

function signalProcesses(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs a command with an argument vector and no shell (except cmd.exe for
 * Windows batch files); rejects only when spawning fails. For every command, a timeout or output overflow kills the whole process tree and reports
 * it as terminated by `SIGTERM`, and the result is returned within a bounded
 * time even if a descendant survives and holds the stdio pipes open. On POSIX the
 * tree is the child and its descendants at the moment of the kill (from a `ps`
 * snapshot, because the child shares agent-depot's process group): they get
 * `SIGTERM`, and if the command has still not closed its output after a grace
 * period, the members of that snapshot still running get `SIGKILL`.
 * A process that left the tree beforehand (daemonized, or orphaned by an exited
 * child) is not killed. On Windows, an argument to a `.cmd`/`.bat` file containing a line
 * break or `& | < >` is rejected with `EINVAL` because cmd.exe cannot carry it
 * safely.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const invocation = spawnInvocation(command, args);
    const sink = childOutputSinks.getStore();
    const child = spawn(invocation.command, [...invocation.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      // Without a capture, stdout is piped only for a sink, and then discarded after it is shown.
      stdio: ["ignore", options.captureStdout || sink !== undefined ? "pipe" : "ignore", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;
    let outputTooLarge = false;
    let timedOut = false;
    let settled = false;
    let terminating = false;
    let killedByRunner = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let posixTree: readonly number[] = [];
    const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      // taskkill ends the process with exit code 1 and no signal, and an escalated kill ends with SIGKILL; report both like child.kill() does, so callers see a terminated process.
      if (killedByRunner && (signal === null || signal === "SIGKILL")) {
        code = null;
        signal = "SIGTERM";
      }
      if (timeout !== undefined) clearTimeout(timeout);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr, outputTooLarge, ...(timedOut ? { timedOut: true } : {}) });
    };
    // A surviving descendant keeps the pipes open, so `close` may never come: give up on them.
    const giveUp = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(child.exitCode, child.signalCode);
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      // A child that already exited must not be killed: its pid may have been reused.
      const running = isRunning();
      if (running) killedByRunner = true;
      if (process.platform === "win32") {
        if (running) killWindowsProcessTree(child);
        graceTimer = setTimeout(giveUp, KILL_GRACE_MS);
        return;
      }
      if (child.pid === undefined) return; // never spawned: `error` has already rejected
      if (!running) {
        graceTimer = setTimeout(giveUp, KILL_GRACE_MS);
        return;
      }
      posixTree = [child.pid];
      // The child's own pid is left alone once it has exited, as it may have been reused.
      const alive = (pids: readonly number[]): readonly number[] => pids.filter((pid) => pid !== child.pid || isRunning());
      // Snapshot before signalling: once the child dies its descendants are reparented and can no longer be found.
      listProcessTree(child.pid).then((tree) => {
        posixTree = tree;
        signalProcesses(alive(tree), "SIGTERM");
      }, () => {
        signalProcesses(alive(posixTree), "SIGTERM");
      });
      graceTimer = setTimeout(() => {
        signalProcesses(alive(posixTree), "SIGKILL");
        graceTimer = setTimeout(giveUp, KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    };
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout?.unref();
    const stdoutDecoder = new StringDecoder("utf8");
    const showStdout = sink !== undefined && (!options.captureStdout || options.streamStdout === true);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.captureStdout) {
        stdoutBytes += chunk.length;
        if (options.maxOutputBytes !== undefined && stdoutBytes > options.maxOutputBytes) {
          outputTooLarge = true;
          terminate();
          return;
        }
        stdout.push(chunk);
      }
      if (showStdout) sink(stdoutDecoder.write(chunk), "stdout");
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      sink?.(chunk, "stderr");
      const bytes = Buffer.from(chunk);
      const remaining = options.maxStderrBytes === undefined
        ? bytes.length : Math.max(0, options.maxStderrBytes - stderrBytes);
      stderrBytes += bytes.length;
      stderr += bytes.subarray(0, remaining).toString("utf8");
      if (options.maxStderrBytes !== undefined && stderrBytes > options.maxStderrBytes) {
        outputTooLarge = true;
        terminate();
      }
    });
    child.on("error", reject);
    child.on("close", settle);
  });
}
