import path from "node:path";

import { defaultSourceStatePath } from "../src/source-state.js";

/**
 * Points the product's per-user state at `home` for the current process and returns the Agent Depot
 * state directory plus a `restore` to call when the test ends. Linux and macOS derive it from the home
 * directory (`isolated-env` removes XDG overrides); Windows reads APPDATA and LOCALAPPDATA, which
 * `isolated-env` pins to one shared directory, so they are redirected per test.
 */
export function isolateUserState(home: string): { readonly stateDirectory: string; readonly restore: () => void } {
  const previous = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  if (process.platform === "win32") {
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return { stateDirectory: path.dirname(defaultSourceStatePath(process.env, process.platform, home)), restore };
}
