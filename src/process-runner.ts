import { spawn } from "node:child_process";
import path from "node:path";

export interface ProcessRunOptions {
  readonly cwd?: string;
  /** Collect stdout instead of discarding it. */
  readonly captureStdout?: boolean;
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
 * Runs a command with an argument vector and no shell (except cmd.exe for
 * Windows batch files); rejects only when spawning fails. On Windows, an
 * argument to a `.cmd`/`.bat` file containing a line break or `& | < >` is
 * rejected with `EINVAL` because cmd.exe cannot carry it safely.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const invocation = spawnInvocation(command, args);
    const child = spawn(invocation.command, [...invocation.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;
    let outputTooLarge = false;
    let timedOut = false;
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    timeout?.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (options.maxOutputBytes !== undefined && stdoutBytes > options.maxOutputBytes) {
        outputTooLarge = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const bytes = Buffer.from(chunk);
      const remaining = options.maxStderrBytes === undefined
        ? bytes.length : Math.max(0, options.maxStderrBytes - stderrBytes);
      stderrBytes += bytes.length;
      stderr += bytes.subarray(0, remaining).toString("utf8");
      if (options.maxStderrBytes !== undefined && stderrBytes > options.maxStderrBytes) {
        outputTooLarge = true;
        child.kill();
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr, outputTooLarge, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}
