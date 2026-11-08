import { waitForFrame } from "./wait-for-frame.js";

const RIGHT = "\u001B[C";

/**
 * Expands every Updates group by walking down the tree (right does nothing on a row, so extra steps are
 * harmless) and leaves the highlight on the first row. Pass `steps` to stop before a "cannot be checked" line.
 */
export async function expandList(lastFrame: () => string | undefined, stdin: { write(data: string): void }, pattern: RegExp | ((frame: string) => boolean), steps = 30): Promise<string> {
  await waitForFrame(lastFrame, /[▸▾] /);
  for (let step = 0; step < steps; step += 1) {
    stdin.write(RIGHT);
    stdin.write("j");
  }
  for (let step = 0; step < steps; step += 1) stdin.write("k");
  stdin.write("j");
  stdin.write("j");
  return waitForFrame(lastFrame, pattern);
}
