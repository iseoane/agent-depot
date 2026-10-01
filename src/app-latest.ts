import type { AppRecipe } from "./app-recipes.js";

/** Public registries only: no ambient credentials, redirects, or unbounded bodies. */
export async function fetchAppLatest(
  latest: Exclude<AppRecipe["latest"], { argv: unknown } | undefined>,
  fetcher: typeof globalThis.fetch,
): Promise<string | undefined> {
  const url = "github" in latest
    ? `https://api.github.com/repos/${latest.github}/releases/latest`
    : `https://registry.npmjs.org/${encodeURIComponent(latest.npm)}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Race also protects callers whose injected fetch/body does not honor abort.
    const timeout = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Latest lookup timed out")), { once: true });
    });
    const response = await Promise.race([fetcher(url, {
      signal: controller.signal, credentials: "omit", redirect: "error", headers: { Accept: "application/json" },
    }), timeout]);
    if (!response.ok || !response.body) return undefined;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) return undefined;
      chunks.push(chunk.value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object") return undefined;
    const value = "github" in latest
      ? ("tag_name" in data ? data.tag_name : undefined)
      : ("version" in data ? data.version : undefined);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
