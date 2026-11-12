import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { parseProjectManifest, ProjectManifestStore } from "../src/project-manifest.js";
import { renderPreviewDocument, stepBlockLines } from "../src/tui/preview-render.js";
import { parseSkillFrontmatter, type SkillCandidate } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import type { PreviewDocument } from "../src/preview-model.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { BorderPanel, DecisionPrompt, FieldLine, ListFooter, Working } from "../src/tui/panel-parts.js";
import { escapeControlText } from "../src/tui/preview-window.js";
import { fakePackageOperations } from "./fake-package-operations.js";
import { renderExpanded } from "./render-expanded.js";
import { waitForFrame } from "./wait-for-frame.js";

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const withoutNewlines = (text: string) => text.replace(/\n/gu, "");
const OSC_52 = "\u001B]52;c;ZXZpbA==\u0007";
const HOSTILE = `x${OSC_52}y\u202Ez`;
const ESCAPED = "x\\x1b]52;c;ZXZpbA==\\x07y\\u202ez";

/** Every byte a view wrote to the terminal, not only its last frame. */
const everything = (frames: readonly string[]) => withoutNewlines(frames.join(""));

class EmptyManifestStore extends ProjectManifestStore {
  constructor() { super("/nonexistent/agent-depot-test/agent-depot.json"); }
  override async load() { return parseProjectManifest({ version: 1, skills: [] }); }
}
const ENVIRONMENT: TuiEnvironment = { projectManifestStore: new EmptyManifestStore(), packages: fakePackageOperations() };

function skillFromFrontmatter(): SkillCandidate {
  const parsed = parseSkillFrontmatter(`---\nname: ${JSON.stringify(`evil${HOSTILE}`)}\ndescription: ${JSON.stringify(`desc${HOSTILE}`)}\n---\nbody\n`);
  assert.ok(parsed, "the hostile frontmatter parses, as a remote SKILL.md would");
  return { sourceId: "builtin:agent-depot", path: "skills/evil", ...parsed };
}

test("the Catalog shows a remote Skill's name and description escaped and never writes their control bytes", async () => {
  const skill = skillFromFrontmatter();
  assert.ok(CONTROL.test(skill.name) && CONTROL.test(skill.description));
  const operations: SourceOperations = {
    async addGitSource() { throw new Error("unused"); },
    async listSources() { return [BUILT_IN_SOURCE]; },
    async refreshSource() { throw new Error("unused"); },
    async selectSources() { return []; },
    discoverSkills: async () => [skill],
  };
  const view = await renderExpanded(<CatalogView environment={ENVIRONMENT} operations={operations} sourceId="builtin:agent-depot" />);
  const frame = await waitForFrame(view.lastFrame, /evil/);
  view.unmount();
  assert.ok(frame.includes(`evil${ESCAPED}`), frame);
  assert.ok(!CONTROL.test(everything(view.frames)), JSON.stringify(view.frames.at(-1)));
});

test("a decision prompt, a working label, a field, a result and a panel title with hostile text write no control bytes", () => {
  const view = render(
    <Box flexDirection="column">
      <BorderPanel title={`Title ${HOSTILE}`}>
        <DecisionPrompt>{`Uninstall ${HOSTILE}?`}</DecisionPrompt>
        <Working label={`Reading ${HOSTILE}`} since={0} animate={false} />
        <FieldLine label="Name:" value={HOSTILE} />
        <ListFooter indicator={`1 of 2 ${HOSTILE}`} selectedCount={0} message={{ kind: "error", text: `failed ${HOSTILE}` }} />
      </BorderPanel>
    </Box>,
  );
  const frame = view.lastFrame() ?? "";
  view.unmount();
  assert.ok(!CONTROL.test(everything(view.frames)), JSON.stringify(frame));
  for (const shown of [`Title ${ESCAPED}`, `Uninstall ${ESCAPED}?`, `Reading ${ESCAPED}`, `Name: ${ESCAPED}`, `1 of 2 ${ESCAPED}`, `failed ${ESCAPED}`]) {
    assert.ok(frame.replace(/[│\s]+/gu, "").includes(shown.replace(/\s+/gu, "")), `${shown}\n${frame}`);
  }
});

test("text without control characters is shown unchanged, including Windows paths and emoji", () => {
  const text = "C:\\Users\\me\\x-files café 日本語 👩‍💻";
  const view = render(<FieldLine label="Path:" value={text} />);
  const frame = view.lastFrame() ?? "";
  view.unmount();
  assert.ok(frame.includes(text), frame);
});

test("a literal backslash that looks like an escape is shown doubled so it cannot be taken for an escaped character", () => {
  assert.equal(escapeControlText("\u001B"), "\\x1b");
  assert.equal(escapeControlText("\\x1b"), "\\\\x1b");
  assert.equal(escapeControlText("\\u202e"), "\\\\u202e");
  assert.equal(escapeControlText("\\\u001B"), "\\\\\\x1b");
  assert.notEqual(escapeControlText("\\x1b"), escapeControlText("\u001B"));
  assert.equal(escapeControlText("C:\\Users\\x\\path"), "C:\\Users\\x\\path");
});

test("manual text with line breaks is shown on separate rows instead of as \\x0a", () => {
  const document: PreviewDocument = {
    action: "Update", summary: "1 App", context: [], warnings: [], failures: [],
    sections: [{ heading: "Apps", items: [{ title: "demo", rows: [{ kind: "field", label: "Manual", value: "first step\nsecond step" }] }] }],
  };
  const shown = [
    ...renderPreviewDocument(document),
    ...stepBlockLines([{ step: "install", cwd: "/tmp", manual: "first step\nsecond step" }]),
  ].map(line => line.map(part => part.text).join(""));
  for (const text of ["first step", "second step"]) {
    assert.equal(shown.filter(line => line.includes(text)).length, 2, shown.join("\n"));
  }
  assert.ok(!shown.some(line => line.includes("first step") && line.includes("second step")), shown.join("\n"));
});

test("only the safe text module imports Ink's Text, so a new view cannot write untrusted text raw", async () => {
  const directory = path.join(import.meta.dirname, "..", "..", "src", "tui");
  const offenders: string[] = [];
  for (const file of await readdir(directory)) {
    if (!/\.tsx?$/u.test(file) || file === "safe-text.tsx") continue;
    const source = await readFile(path.join(directory, file), "utf8");
    if (/import\s*\{[^}]*\bText\b[^}]*\}\s*from\s*"ink"/u.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
