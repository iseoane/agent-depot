import type { GitSourceSnapshotFile } from "./git-source.js";

export const SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 4096, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024,
});

/** Git batch payloads are byte framed: contents may themselves contain newlines or NULs. */
export function decodeSnapshotBatch(output: Uint8Array, entries: readonly { path: string; objectId: string }[]): readonly GitSourceSnapshotFile[] {
  const bytes = Buffer.from(output);
  let offset = 0;
  let total = 0;
  const files = entries.map(entry => {
    const end = bytes.indexOf(10, offset);
    if (end < offset || end - offset > 128) throw new Error("Malformed Git batch header");
    const header = bytes.subarray(offset, end).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header.length !== 3 || header[0] !== entry.objectId || header[1] !== "blob"
      || !/^\d+$/u.test(header[2]) || !Number.isSafeInteger(size) || size > SOURCE_SNAPSHOT_LIMITS.maxFileBytes) {
      throw new Error("Invalid Git batch object or size limit");
    }
    total += size;
    if (total > SOURCE_SNAPSHOT_LIMITS.maxTotalBytes) throw new Error("Git snapshot exceeds total size limit");
    offset = end + 1;
    if (offset + size >= bytes.length || bytes[offset + size] !== 10) throw new Error("Truncated Git batch object");
    const content = bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
    return Object.freeze({ path: entry.path, content });
  });
  if (offset !== bytes.length) throw new Error("Unexpected trailing Git batch output");
  return Object.freeze(files);
}

// Default readers share immutable work; injected runners have separate cache domains.
// Only small results are retained, with at most eight entries per runner (32 MiB of UTF-8 data).
const caches = new WeakMap<object, Map<string, Promise<readonly GitSourceSnapshotFile[]>>>();
export function reuseSourceSnapshot(owner: object, key: string, load: () => Promise<readonly GitSourceSnapshotFile[]>): Promise<readonly GitSourceSnapshotFile[]> {
  let cache = caches.get(owner);
  if (!cache) { cache = new Map(); caches.set(owner, cache); }
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const pending = load();
  const remove = () => { if (cache.get(key) === pending) cache.delete(key); };
  cache.set(key, pending);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  void pending.then(files => {
    if (files.reduce((size, file) => size + Buffer.byteLength(file.content, "utf8"), 0) > 4 * 1024 * 1024) remove();
  }, remove);
  return pending;
}
