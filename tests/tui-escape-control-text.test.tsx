import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { PagedPreview } from "../src/tui/panel-parts.js";
import { previewViewport, type PreviewChrome } from "../src/tui/preview-window.js";
import { span } from "../src/tui/preview-render.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { confirmAtEnd, PREVIEW_SIZES, resizeTerminal } from "./preview-footer.js";
import { squash, waitForFrame, waitForSettled } from "./wait-for-frame.js";
import { deferCleanup } from "./test-cleanup.js";

const HOSTILE = "a\u001B[2Jb\rc\bd\u202Ee";
const ESCAPED = "a\\x1b[2Jb\\x0dc\\x08d\\u202ee";
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const withoutNewlines = (frame: string) => frame.replace(/\n/gu, "");

test("a preview shows control and format characters escaped, in plain lines, styled lines, the title and the footer", () => {
  const chrome: PreviewChrome = { title: `Title ${HOSTILE}`, action: `Do ${HOSTILE}`, consequence: `Do ${HOSTILE}? y/n`, cancel: `[n] ${HOSTILE}` };
  const lines = [`plain ${HOSTILE}`, `styled ${HOSTILE}`, "Café 日本語 🙂 ok"];
  const styled = [undefined, [span("styled ", "white"), span(HOSTILE, "red", true)], undefined];
  const viewport = previewViewport(lines, 0, 40, 200, chrome);
  const view = render(<PagedPreview chrome={chrome} lines={lines} styled={styled} viewport={viewport} />);
  const frame = view.lastFrame() ?? "";
  view.unmount();
  assert.ok(!CONTROL.test(withoutNewlines(frame)), JSON.stringify(frame));
  assert.equal(frame.split("\n").filter(row => row.includes(`plain ${ESCAPED}`)).length, 1, frame);
  assert.equal(frame.split("\n").filter(row => row.includes(`styled ${ESCAPED}`)).length, 1, frame);
  assert.ok(frame.includes(`Title ${ESCAPED}`), frame);
  assert.ok(frame.includes(`[y] Do ${ESCAPED}`), frame);
  assert.ok(frame.includes(`[n] ${ESCAPED}`), frame);
  assert.ok(frame.includes("Café 日本語 🙂 ok"), frame);
  assert.ok(viewport.reachedEnd);
});

test("the geometry wraps the escaped text, so a line of invisible characters takes the rows it is shown on", () => {
  const lines = ["\u001B".repeat(50), "\u202E".repeat(50)];
  const viewport = previewViewport(lines, 0, 100, 40, { title: "t" });
  assert.ok(viewport.total > 2, `${viewport.total} rows`);
  for (const row of viewport.rows) {
    assert.ok(!CONTROL.test(row), JSON.stringify(row));
    assert.ok(stringWidth(row) <= 32, JSON.stringify(row));
  }
});

test("a preview that needs no escaping keeps its text", () => {
  const lines = ["ASCII only", "Acentos: áéíóú ñ", "日本語のテキスト", "emoji 🙂👍🏽", "a\\x1b literal backslash"];
  const viewport = previewViewport(lines, 0, 100, 120, { title: "t" });
  assert.deepEqual(viewport.rows, lines);
});

for (const size of PREVIEW_SIZES) {
  test(`a recipe with control characters in its name, homepage and manual text is reviewed escaped at ${size.columns}x${size.rows}`, async t => {
    const home = await mkdtemp(path.join(tmpdir(), "escape-recipe-"));
    const directory = path.join(home, "state", "apps");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "demo.json"), JSON.stringify({ name: `demo${HOSTILE}`, homepage: `https://example.com/${HOSTILE}`,
      install: { manual: `install${HOSTILE}` }, update: { manual: "update" }, uninstall: { manual: "remove" },
      version: { argv: ["demo", "version"], pattern: "(.*)" } }));
    const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory: directory, platform: "linux", isWsl: false,
      resolveExecutable: async name => `/usr/bin/${name}`, runner: async () => { throw new Error("No recipe command should run"); },
      fetch: async () => { throw new Error("No latest lookup should run"); } };
    const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") });
    const view = render(<SourcesView operations={operations} environment={{ homeDirectory: home, projectRoot: home, appEnvironment }} />);
    deferCleanup(t, async () => {
      try { await waitForSettled(view.lastFrame); } finally { view.unmount(); await rm(home, { recursive: true, force: true }); }
    });
    resizeTerminal(view, size);
    await waitForFrame(view.lastFrame, /needs\s+approval/);
    view.stdin.write("\r");
    const apps = createAppOperations(appEnvironment);
    const preview = await waitForFrame(view.lastFrame, /read [█░]* ?\d+%/u);
    assert.ok(!CONTROL.test(withoutNewlines(preview)), JSON.stringify(preview));
    const end = await confirmAtEnd(view, size.rows, /\[y\] Approve demo/, () => /✓ approved/.test(view.lastFrame() ?? ""));
    assert.ok(!CONTROL.test(withoutNewlines(end)), JSON.stringify(end));
    assert.ok(squash(end).includes(squash(`Approve demo${ESCAPED}? y/n`)), end);
    assert.equal((await apps.inspect((await apps.load())[0]!, {})).status, "approved");
  });
}
