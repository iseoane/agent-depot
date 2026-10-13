import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { compareAppVersions } from "./app-version.js";
import { createPortableExecutableResolver, type PortableExecutableResolver } from "./executable-resolution.js";
import { runProcess, type ProcessRunResult } from "./process-runner.js";

const REGISTRY_URL = "https://registry.npmjs.org";
const MAX_REGISTRY_RESPONSE_BYTES = 8 * 1024;
const MAX_NPM_STDERR_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export type SelfUpdateStatus =
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "current"; readonly current: string; readonly latest: string }
  | { readonly kind: "ahead"; readonly current: string; readonly latest: string }
  | { readonly kind: "available"; readonly current: string; readonly latest: string };

export interface SelfUpdateOperations {
  check(): Promise<SelfUpdateStatus>;
  apply(version: string): Promise<void>;
}

export interface SelfUpdateOptions {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly resolveExecutable?: PortableExecutableResolver;
  readonly run?: (executable: string, args: readonly string[], options?: {
    readonly captureStdout?: boolean;
    readonly maxOutputBytes?: number;
    readonly maxStderrBytes?: number;
    readonly timeoutMs?: number;
  }) => Promise<ProcessRunResult>;
  readonly fetch?: typeof globalThis.fetch;
}

function compareVersions(left: string, right: string): number {
  const comparison = compareAppVersions(left, right);
  if (comparison === undefined) throw new Error(`Invalid semantic version comparison ${JSON.stringify(left)} and ${JSON.stringify(right)}`);
  return comparison;
}

async function latestVersion(fetcher: typeof globalThis.fetch, packageName: string): Promise<string> {
  const encodedName = encodeURIComponent(packageName).replace(/^%40/u, "@");
  const response = await fetcher(`${REGISTRY_URL}/${encodedName}/latest`, {
    signal: AbortSignal.timeout(10_000),
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRY_RESPONSE_BYTES) {
    throw new Error("npm registry response exceeded the size limit");
  }
  if (!response.body) throw new Error("npm registry response did not include a body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      responseBytes += chunk.value.byteLength;
      if (responseBytes > MAX_REGISTRY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("npm registry response exceeded the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("npm registry returned invalid JSON");
  }
  if (typeof payload !== "object" || payload === null || !("version" in payload) || typeof payload.version !== "string") {
    throw new Error("npm registry response did not contain a version");
  }
  compareVersions(payload.version, payload.version);
  return payload.version;
}

function successfulStdout(result: ProcessRunResult): string | undefined {
  if (result.code !== 0 || result.signal !== null || result.timedOut || result.outputTooLarge) return undefined;
  return result.stdout.toString("utf8").trim();
}

export function createSelfUpdateOperations(options: SelfUpdateOptions): SelfUpdateOperations {
  const resolveExecutable = options.resolveExecutable ?? createPortableExecutableResolver();
  const run = options.run ?? runProcess;
  const fetcher = options.fetch ?? globalThis.fetch;

  async function npmGlobalExecutable(): Promise<string | undefined> {
    const npm = await resolveExecutable("npm");
    if (npm.blocked || npm.executable === undefined) return undefined;
    const target = await realpath(npm.executable).catch(() => undefined);
    if (target === undefined || path.basename(target) !== "npm-cli.js" || path.basename(path.dirname(target)) !== "bin" || path.basename(path.dirname(path.dirname(target))) !== "npm") return undefined;
    let rootResult: ProcessRunResult;
    try {
      rootResult = await run(npm.executable, ["root", "--global", "--silent", "--logs-max=0", "--no-update-notifier"], {
        captureStdout: true,
        maxOutputBytes: 4096,
        maxStderrBytes: MAX_NPM_STDERR_BYTES,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch {
      return undefined;
    }
    const globalRoot = successfulStdout(rootResult);
    if (globalRoot === undefined || !path.isAbsolute(globalRoot)) return undefined;
    const installedPackagePath = path.join(globalRoot, ...options.packageName.split("/"));
    const installedPackage = await lstat(installedPackagePath).catch(() => undefined);
    if (installedPackage === undefined || !installedPackage.isDirectory()) return undefined;
    const actualRoot = await realpath(options.packageRoot).catch(() => undefined);
    const reportedRoot = await realpath(installedPackagePath).catch(() => undefined);
    return actualRoot !== undefined && actualRoot === reportedRoot ? npm.executable : undefined;
  }

  return {
    async check(): Promise<SelfUpdateStatus> {
      compareVersions(options.packageVersion, options.packageVersion);
      const npm = await npmGlobalExecutable();
      if (npm === undefined) {
        return { kind: "unsupported", reason: "this CLI is not verified in npm's global package directory" };
      }
      const latest = await latestVersion(fetcher, options.packageName);
      const comparison = compareVersions(latest, options.packageVersion);
      if (comparison === 0) return { kind: "current", current: options.packageVersion, latest };
      if (comparison < 0) return { kind: "ahead", current: options.packageVersion, latest };
      return { kind: "available", current: options.packageVersion, latest };
    },
    async apply(version: string): Promise<void> {
      let comparison: number;
      try {
        comparison = compareVersions(version, options.packageVersion);
      } catch {
        throw new Error(`Refusing invalid Agent Depot version ${JSON.stringify(version)}`);
      }
      if (comparison <= 0) throw new Error(`Refusing to downgrade Agent Depot from ${options.packageVersion} to ${version}`);
      const npm = await npmGlobalExecutable();
      if (npm === undefined) throw new Error("this CLI is not verified in npm's global package directory");
      const result = await run(npm, [
        "install", "--global", "--no-audit", "--no-fund", "--no-update-notifier", "--logs-max=0", "--ignore-scripts", "--prefer-online",
        "--registry=https://registry.npmjs.org/", `${options.packageName}@${version}`,
      ], { maxStderrBytes: MAX_NPM_STDERR_BYTES, timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.code !== 0 || result.signal !== null || result.timedOut || result.outputTooLarge) {
        const detail = result.timedOut ? "timed out" : result.outputTooLarge ? "produced too much output" : result.signal ? `stopped by ${result.signal}` : `exited with code ${result.code ?? "unknown"}`;
        throw new Error(`npm global update ${detail}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
      }
    },
  };
}
