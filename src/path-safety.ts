import { lstat } from "node:fs/promises";
import path from "node:path";

/** True when the paths are equal or one contains the other. Callers normalize first. */
export function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || reverse === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
    (!reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse));
}

/** Walks every existing component of a path and rejects the first symbolic link. */
export async function assertNoSymlinkPath(candidate: string, label: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const root = path.parse(absolute).root;
  let current = root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
