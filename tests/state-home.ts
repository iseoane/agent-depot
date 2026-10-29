import path from "node:path";

import { defaultSourceStatePath } from "../src/source-state.js";

const MANAGED = ["XDG_STATE_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA"] as const;

/**
 * Points the product's per-user state and cache at `home` for the current process and returns the
 * Agent Depot state directory plus a `restore` to call when the test ends. It does not rely on the
 * `isolated-env` preload: POSIX pins XDG_STATE_HOME and XDG_CACHE_HOME to `home`, Windows pins
 * APPDATA and LOCALAPPDATA (`isolated-env` shares one directory across tests there), so a shell
 * override cannot redirect a write to real user state.
 */
export function isolateUserState(home: string): { readonly stateDirectory: string; readonly restore: () => void } {
  const previous = Object.fromEntries(MANAGED.map(key => [key, process.env[key]]));
  if (process.platform === "win32") {
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  } else {
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    process.env.XDG_CACHE_HOME = path.join(home, ".cache");
  }
  const restore = () => {
    for (const key of MANAGED) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
  return { stateDirectory: path.dirname(defaultSourceStatePath(process.env, process.platform, home)), restore };
}
