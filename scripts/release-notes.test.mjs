import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releaseNotes } from "./release-notes.mjs";

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [0.6.6] - 2026-10-29",
  "",
  "### Fixed",
  "",
  "- Windows fix (#70).",
  "",
  "## [0.6.5] - 2026-10-29",
  "",
  "### Added",
  "",
  "- Spinner.",
  "",
].join("\n");

test("releaseNotes returns only the requested version's section", () => {
  assert.equal(releaseNotes(changelog, "0.6.6"), "## [0.6.6] - 2026-10-29\n\n### Fixed\n\n- Windows fix (#70).\n");
  assert.equal(releaseNotes(changelog, "0.6.5"), "## [0.6.5] - 2026-10-29\n\n### Added\n\n- Spinner.\n");
});

test("releaseNotes accepts CRLF changelogs", () => {
  assert.equal(releaseNotes(changelog.replace(/\n/g, "\r\n"), "0.6.6"), "## [0.6.6] - 2026-10-29\n\n### Fixed\n\n- Windows fix (#70).\n");
});

test("releaseNotes rejects a missing version and does not match a prefix", () => {
  assert.throws(() => releaseNotes(changelog, "0.6.7"), /CHANGELOG\.md has no ## \[0\.6\.7\] section/);
  assert.throws(() => releaseNotes(changelog, "0.6"), /no ## \[0\.6\] section/);
  assert.throws(() => releaseNotes("## [0.6.10] - 2026-10-30\n\n- Later.\n", "0.6.1"), /no ## \[0\.6\.1\] section/);
});

test("the CLI writes the notes file and fails without writing for a missing version", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-depot-release-notes-"));
  try {
    const script = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
    const input = path.join(directory, "CHANGELOG.md");
    const output = path.join(directory, "notes.md");
    writeFileSync(input, changelog);
    execFileSync(process.execPath, [script, input, "0.6.6", output]);
    assert.equal(readFileSync(output, "utf8"), "## [0.6.6] - 2026-10-29\n\n### Fixed\n\n- Windows fix (#70).\n");
    const missing = path.join(directory, "missing.md");
    assert.throws(() => execFileSync(process.execPath, [script, input, "9.9.9", missing], { stdio: "pipe" }), /no ## \[9\.9\.9\] section/);
    assert.throws(() => readFileSync(missing));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
