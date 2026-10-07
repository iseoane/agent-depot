import { spawn } from "node:child_process";

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

/** Runs a command with an argument vector and no shell; rejects only when spawning fails. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      shell: false,
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
