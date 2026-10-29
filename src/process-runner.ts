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

/** How long `runProcess` waits for stdio to close after killing a Windows process tree before it gives up on it. */
const WINDOWS_KILL_GRACE_MS = 2_000;

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
 * Runs a command with an argument vector and no shell (except cmd.exe for
 * Windows batch files); rejects only when spawning fails. For every command on
 * Windows, a timeout or output overflow kills the whole process tree and reports
 * it as terminated by `SIGTERM`, and the result is returned within a bounded
 * time even if a descendant survives and holds the stdio pipes open. Also on Windows, an argument to a `.cmd`/`.bat` file containing a line
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
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      // taskkill ends the process with exit code 1 and no signal; report it like child.kill() does, so callers see a terminated process.
      if (killedByRunner && signal === null) {
        code = null;
        signal = "SIGTERM";
      }
      if (timeout !== undefined) clearTimeout(timeout);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr, outputTooLarge, ...(timedOut ? { timedOut: true } : {}) });
    };
    const terminate = (): void => {
      if (process.platform !== "win32") {
        child.kill();
        return;
      }
      if (terminating) return;
      terminating = true;
      // A child that already exited must not be killed: its pid may have been reused.
      if (child.exitCode === null && child.signalCode === null) {
        killedByRunner = true;
        killWindowsProcessTree(child);
      }
      // A surviving descendant keeps the pipes open, so `close` may never come: give up on them.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(child.exitCode, child.signalCode);
      }, WINDOWS_KILL_GRACE_MS);
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
