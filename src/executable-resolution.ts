import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

/** One host executable resolution; `blocked` means no-shell spawn cannot run it here. */
export interface PortableExecutableResolution {
  readonly executable?: string;
  /** True for a Windows executable reachable from WSL, which cannot be spawned from Linux. */
  readonly blocked: boolean;
}

export interface PortableExecutableResolverOptions {
  readonly platform?: NodeJS.Platform;
  /** Test seam for simulated WSL; defaults to the WSL environment variables. */
  readonly isWsl?: boolean;
  /** Test seam for simulated Windows drive mounts; defaults to /mnt. */
  readonly wslMountRoot?: string;
  readonly resolveExecutable?: (name: string) => Promise<string | undefined>;
}

export type PortableExecutableResolver = (name: string) => Promise<PortableExecutableResolution>;

interface WslEnvironment {
  readonly isWsl: boolean;
  readonly wslMountRoot: string;
}

/** A POSIX path on a mounted Windows drive, which WSL cannot execute. */
export function isWindowsExecutableOnWsl(executable: string, environment: WslEnvironment): boolean {
  const relative = path.posix.relative(environment.wslMountRoot, executable);
  return environment.isWsl && /^[a-z]\//iu.test(relative);
}

/**
 * Resolves one host executable without a shell. The injected resolver is the
 * test and embedding seam; otherwise the name is looked up on PATH, and a
 * Windows executable reachable from WSL is reported as blocked rather than run.
 */
export function createPortableExecutableResolver(
  options: PortableExecutableResolverOptions = {},
): PortableExecutableResolver {
  const platform = options.platform ?? process.platform;
  const injected = options.resolveExecutable;
  const wslEnvironment: WslEnvironment = {
    isWsl: options.isWsl ?? (
      platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
    ),
    wslMountRoot: options.wslMountRoot ?? "/mnt",
  };

  return async function resolve(name: string): Promise<PortableExecutableResolution> {
    if (injected) {
      const executable = await injected(name);
      const target = executable ? await realpath(executable).catch(() => executable) : undefined;
      return { executable, blocked: target !== undefined && isWindowsExecutableOnWsl(target, wslEnvironment) };
    }

    let blockedExecutable: string | undefined;
    const suffixes = platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) {
        continue;
      }
      for (const suffix of suffixes) {
        const candidate = path.join(directory, name + suffix);
        try {
          await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
          const target = await realpath(candidate);
          if (isWindowsExecutableOnWsl(target, wslEnvironment)) {
            blockedExecutable ??= candidate;
            continue;
          }
          // Preserve shim/multicall identity when spawning; realpath is only a safety check.
          return { executable: candidate, blocked: false };
        } catch {
          // Try the next PATH entry.
        }
      }
    }
    return { executable: blockedExecutable, blocked: blockedExecutable !== undefined };
  };
}
