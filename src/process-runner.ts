import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  readonly cwd?: string;
  /** Collect stdout instead of discarding it. */
  readonly captureStdout?: boolean;
  /** Kill the process if either captured output stream exceeds this many bytes. */
  readonly maxOutputBytes?: number;
}

export interface ProcessRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly outputTooLarge: boolean;
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
      const remaining = options.maxOutputBytes === undefined
        ? bytes.length : Math.max(0, options.maxOutputBytes - stderrBytes);
      stderrBytes += bytes.length;
      stderr += bytes.subarray(0, remaining).toString("utf8");
      if (options.maxOutputBytes !== undefined && stderrBytes > options.maxOutputBytes) {
        outputTooLarge = true;
        child.kill();
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr, outputTooLarge });
    });
  });
}
