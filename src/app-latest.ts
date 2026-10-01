import { AGENT_DEPOT_PACKAGE_VERSION } from "./project-manifest.js";
import type { AppRecipe } from "./app-recipes.js";

/** Public registries only: no ambient credentials, redirects, or unbounded bodies. */
export async function fetchAppLatest(
  latest: Exclude<AppRecipe["latest"], { argv: unknown } | undefined>,
  fetcher: typeof globalThis.fetch,
): Promise<{ latestVersion?: string; reason?: string }> {
  const url = "github" in latest
    ? `https://api.github.com/repos/${latest.github.split("/").map(encodeURIComponent).join("/")}/releases/latest`
    : `https://registry.npmjs.org/${encodeURIComponent(latest.npm).replace(/^%40/u, "@")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let receivedResponse = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Race also protects callers whose injected fetch/body does not honor abort.
    const timeout = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Latest lookup timed out")), { once: true });
    });
    void timeout.catch(() => {});
    const response = await Promise.race([fetcher(url, {
      signal: controller.signal, credentials: "omit", redirect: "manual", headers: "github" in latest ? {
        Accept: "application/vnd.github+json", "User-Agent": `agent-depot/${AGENT_DEPOT_PACKAGE_VERSION ?? "unknown"}`,
        "X-GitHub-Api-Version": "2022-11-28",
      } : { Accept: "application/vnd.npm.install-v1+json" },
    }), timeout]);
    receivedResponse = true;
    if (response.status >= 300 && response.status < 400) {
      return { reason: `redirected — update latest.${"github" in latest ? "github" : "npm"}` };
    }
    if (response.status === 429 || (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0")) {
      return { reason: "rate-limited" };
    }
    if (!response.ok) return { reason: `HTTP ${response.status}` };
    if (!response.body) return { reason: "invalid response" };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) return { reason: "too large" };
      chunks.push(chunk.value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object") return { reason: "invalid response" };
    const value = "github" in latest
      ? ("tag_name" in data ? data.tag_name : undefined)
      : ("dist-tags" in data && data["dist-tags"] && typeof data["dist-tags"] === "object"
        && "latest" in data["dist-tags"] ? data["dist-tags"].latest : undefined);
    return typeof value === "string" && value.trim() ? { latestVersion: value.trim() } : { reason: "invalid response" };
  } catch {
    return { reason: controller.signal.aborted ? "timeout" : receivedResponse ? "invalid response" : "network error" };
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
