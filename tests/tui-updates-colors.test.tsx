import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const ansi = (red: number, green: number, blue: number, text: string) => `\u001b[38;2;${red};${green};${blue}m${text}`;

test("Updates and shared confirmation panels use semantic Xeo colors", () => {
  const script = `
    import React from "react";
    import { render } from "ink-testing-library";
    import { DecisionPrompt, PreviewConfirm } from "./dist/src/tui/panel-parts.js";
    import { Header } from "./dist/src/tui/app.js";
    import { CheckStatus, EntryLine, UpdatesFooter } from "./dist/src/tui/updates-panel.js";
    import { TreeRowLine } from "./dist/src/tui/installations-rows.js";
    const frame = element => { const view = render(element); const result = view.lastFrame() ?? ""; view.unmount(); return result; };
    const treeRow = data => ({ node: { id: data.kind, data }, depth: 0, expanded: false, expandable: false });
    const browse = frame(React.createElement(EntryLine, {
      entry: { kind: "update", row: { path: "skills/demo", scope: "user-global", policy: "latest", installed: "1.0.0", available: "2.0.0" } },
      selected: false, checked: false, view: { unknown: [] }, showUnknown: false,
    }));
    const result = frame(React.createElement(UpdatesFooter, {
      indicator: undefined, upToDate: 0, updatableCount: 0, checkedCount: 0,
      message: { kind: "ok", lines: ["Update summary: 1 updated, 0 failed", "Updated App: demo: installed 1.0.0 -> 2.0.0 (latest 2.0.0)"] },
    }));
    const failure = frame(React.createElement(UpdatesFooter, {
      indicator: undefined, upToDate: 0, updatableCount: 0, checkedCount: 0,
      message: { kind: "error", lines: ["Updated App: demo: installed 1.0.0 -> 2.0.0", "Failed App: demo: network unreachable", "Update summary: 1 updated, 1 failed"] },
    }));
    const check = frame(React.createElement(CheckStatus, {
      data: { results: [{ scope: "project", error: "manifest exploded" }], rows: [], refresh: { attempted: false, refreshed: [], failed: [], unreadable: [] }, checkedAt: 1000 },
      now: 1000,
    }));
    const preview = frame(React.createElement(PreviewConfirm, {
      lines: ["  target: skills/demo", "  proposed changes: replace 2 managed files"],
      question: "Apply 1 update? y/n · note",
    }));
    const profilePreview = frame(React.createElement(PreviewConfirm, {
      lines: ["Destination: /tmp/profile.json", "Preview: export portable user-global profile",
        "Source git:abc123 https://example.test/skills.git (included: true)",
        "Skill skills/demo [pi, codex] (latest)", "App recipe demo (linux; approval not transferred)",
        "Package pi plugins/demo from https://example.test/demo.git (latest; saved selection); no receipt or installed evidence",
        "Replica intent Installed Skill skills/demo from https://example.test/skills.git; no installed state or approval is transferred",
        "WARNING: profile Agent Depot 99.0.0 is newer than running 0.6.0"],
      question: "Save/Export Profile? (y/n)",
    }));
    const importPreview = frame(React.createElement(PreviewConfirm, {
      lines: ["Preview: import portable user-global profile", "add: Skill skills/demo",
        "  hosts: pi,codex; version policy: latest", "  Source https://example.test/skills.git", "WARNING: invalid recipe"],
      question: "Apply Profile? (y/n)",
    }));
    const unmatchedPreview = frame(React.createElement(PreviewConfirm, {
      lines: ["Skill command [shell command] (custom)"], question: "Review?",
    }));
    const longProfileLines = [
      "Source git:" + "0123456789abcdef".repeat(8) + " https://example.test/" + "source-segment/".repeat(12) + "skills.git (included: true)",
      "Skill skills/" + "long-skill-directory/".repeat(12) + "skill [pi, codex, claude] (latest)",
      "Package " + "package/".repeat(12) + "demo from https://example.test/" + "package-source/".repeat(10) + "repo.git (latest; saved selection)",
    ];
    const longProfile = Array.from({ length: 60 }, (_, cursor) => frame(React.createElement(PreviewConfirm, {
      lines: longProfileLines, cursor, question: "Apply Profile? (y/n)",
    }))).join("\\n");
    const prompt = frame(React.createElement(DecisionPrompt, null, "Refresh these Sources?"));
    const header = frame(React.createElement(Header, { view: "updates", columns: 80 }));
    const skillVersion = frame(React.createElement(TreeRowLine, { row: treeRow({ kind: "installation", row: { scope: "user-global", selection: { path: "skills/demo", hosts: ["pi"] }, source: "builtin:agent-depot", policy: "latest", installed: "1.0.0", adopted: false } }), selected: false, marked: false }));
    const appVersion = frame(React.createElement(TreeRowLine, { row: treeRow({ kind: "app", row: { entry: { file: "apps/demo.json", recipe: { name: "demo" } }, inspection: { status: "installed", installedVersion: "1.0.0", evidence: "recorded" } } }), selected: false, marked: false }));
    const packageVersion = frame(React.createElement(TreeRowLine, { row: treeRow({ kind: "package", row: { selection: { host: "pi" }, name: "demo", installed: "installed 1.0.0", installedVersion: "1.0.0", available: "2.0.0", status: { kind: "current" } } }), selected: false, marked: false }));
    process.stdout.write([browse, result, failure, check, preview, profilePreview, importPreview, unmatchedPreview, longProfile, prompt, header, skillVersion, appVersion, packageVersion].join("\\n---\\n"));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  assert.equal(child.status, 0, child.stderr);
  const [browse, result, failure, check, preview, profilePreview, importPreview, unmatchedPreview, longProfile, prompt, header, skillVersion, appVersion, packageVersion] = child.stdout.split("\n---\n");
  assert.ok(browse?.includes(ansi(122, 162, 247, "skills/demo")), "browse path is blue");
  assert.ok(browse?.includes(ansi(122, 162, 247, "user-global")), "browse scope is blue");
  assert.ok(browse?.includes(ansi(192, 202, 245, "1.0.0")), "installed version is light");
  assert.ok(browse?.includes(ansi(192, 202, 245, "2.0.0")), "available version is light");

  assert.ok(result?.includes(ansi(158, 206, 106, "[OK]")), "success is a separate green indicator");
  assert.ok(result?.includes(ansi(122, 162, 247, "Update summary:")), "summary label is blue");
  assert.ok(result?.includes(ansi(192, 202, 245, " 1 updated, 0 failed")), "summary value is light");
  assert.ok(result?.includes(ansi(122, 162, 247, "Updated")), "updated label is blue");
  assert.ok(result?.includes(ansi(192, 202, 245, " App: demo: installed 1.0.0 -> 2.0.0 (latest 2.0.0)")), "update details are light");
  assert.ok(!result?.includes(ansi(158, 206, 106, "Update summary: 1 updated, 0 failed")), "success does not color the full summary green");
  assert.ok(failure?.includes(ansi(247, 118, 142, "[FAIL]")), "failure is a separate red indicator");
  assert.ok(failure?.includes(ansi(122, 162, 247, "Failed")), "failure label is blue");
  assert.ok(failure?.includes(ansi(192, 202, 245, " App: demo: network unreachable")), "failure details are light");
  assert.ok(failure?.includes(ansi(122, 162, 247, "Update summary:")), "failed summary label is blue");
  assert.ok(!failure?.includes(ansi(247, 118, 142, "Failed App: demo: network unreachable")), "failure does not color the full line red");
  assert.ok(check?.includes(ansi(247, 118, 142, "[FAIL]")), "check error has a separate red indicator");
  assert.ok(check?.includes(ansi(122, 162, 247, "Error (project):")), "check error field is blue");
  assert.ok(check?.includes(ansi(192, 202, 245, " manifest exploded")), "check error value is light");

  assert.ok(profilePreview?.includes(ansi(122, 162, 247, "Destination:")), "Profile destination label is blue");
  assert.ok(profilePreview?.includes(ansi(192, 202, 245, " /tmp/profile.json")), "Profile destination value is light");
  assert.ok(profilePreview?.includes(ansi(122, 162, 247, "Preview:")), "Profile preview label is blue");
  assert.ok(profilePreview?.includes(ansi(65, 72, 104, "git:abc123")), "Source identity is muted");
  assert.ok(profilePreview?.includes(ansi(122, 162, 247, "included:")), "Source inclusion field is blue");
  assert.ok(profilePreview?.includes(ansi(192, 202, 245, " https://example.test/skills.git")), "Source URL is light");
  assert.ok(profilePreview?.includes(`\u001b[1mskills/demo`), "Skill name is bold");
  assert.ok(profilePreview?.includes(ansi(122, 162, 247, "pi, codex")), "Skill hosts use the marker color");
  assert.ok(profilePreview?.includes(ansi(255, 158, 100, "latest")), "Skill version policy is orange");
  assert.ok(profilePreview?.includes(`\u001b[1mdemo`), "App name is bold");
  assert.ok(profilePreview?.includes(ansi(255, 158, 100, "latest")), "Package version policy is orange");
  assert.ok(profilePreview?.includes(ansi(122, 162, 247, "Replica intent")), "Replica intent category is blue");
  assert.ok(profilePreview?.includes(`\u001b[1mskills/demo`), "Replica Skill name is bold");
  assert.ok(profilePreview?.includes(ansi(224, 175, 104, "WARNING: profile Agent Depot")), "Profile warnings are amber");
  assert.ok(importPreview?.includes(ansi(122, 162, 247, "add:")), "Import action is blue");
  assert.ok(importPreview?.includes(`\u001b[1mskills/demo`), "Import Skill name is bold");
  assert.ok(importPreview?.includes(ansi(122, 162, 247, "version policy:")), "Import version field is blue");
  assert.ok(importPreview?.includes(ansi(255, 158, 100, " latest")), "Import version policy is orange");
  assert.ok(importPreview?.includes(ansi(122, 162, 247, "  Source")), "Import Source field is blue");
  assert.ok(unmatchedPreview?.includes(ansi(192, 202, 245, "Skill command [shell command] (custom)")), "unmatched brackets and parentheses stay plain");
  assert.ok(longProfile?.includes(ansi(65, 72, 104, "git:0123456789abcdef")), "wrapped Source identity keeps its muted color");
  assert.ok(longProfile?.includes(ansi(192, 202, 245, "ment/source-segment")), "wrapped Source URL continuation keeps its value color");
  assert.ok(longProfile?.includes(`\u001b[1m${"skills/long-skill-directory/"}`), "wrapped Skill path stays bold");
  assert.ok(longProfile?.includes(ansi(122, 162, 247, "codex, claude")), "wrapped Skill host continuation keeps its marker color");
  assert.ok(longProfile?.includes(ansi(255, 158, 100, "latest")), "wrapped Skill policy keeps its version color");
  assert.ok(longProfile?.includes(`\u001b[1m${"package/package/"}`), "wrapped Package path stays bold");
  assert.ok(longProfile?.includes(ansi(192, 202, 245, "age-source/package-source/pack")), "wrapped Package Source retains its value color");

  assert.ok(preview?.includes(ansi(255, 46, 154, "Confirmation")), "panel title remains fuchsia");
  assert.ok(preview?.includes(ansi(122, 162, 247, "  target:")), "CLI target field label is blue");
  assert.ok(preview?.includes(ansi(192, 202, 245, " skills/demo")), "CLI target value is light");
  assert.ok(preview?.includes(ansi(122, 162, 247, "  proposed changes:")), "CLI proposed changes label is blue");
  assert.ok(preview?.includes(ansi(192, 202, 245, " replace 2 managed files")), "CLI proposed changes value is light");
  assert.ok(preview?.includes(ansi(224, 175, 104, "Apply 1 update? ")), "question text is warning yellow");
  assert.ok(preview?.includes(`\u001b[1m${ansi(158, 206, 106, "y")}`), "affirmative key is bold green");
  assert.ok(preview?.includes(ansi(86, 95, 137, "/")), "separator remains gray");
  assert.ok(preview?.includes(ansi(247, 118, 142, "n")), "negative key remains red");
  assert.ok(preview?.includes(ansi(86, 95, 137, " · note")), "question suffix remains gray");
  assert.ok(prompt?.includes(ansi(224, 175, 104, "Refresh these Sources?")), "shared DecisionPrompt text is warning yellow");
  assert.ok(header?.includes(ansi(255, 46, 154, "AGENT DEPOT")), "brand is bold fuchsia");
  assert.ok(header?.includes(ansi(255, 46, 154, "╭")), "header border is fuchsia");
  assert.ok(header?.includes(ansi(255, 46, 154, "  ▶ [4] Updates")), "active tab remains fuchsia");
  assert.ok(header?.includes(ansi(86, 95, 137, "[1] Sources")), "inactive tab remains gray");

  assert.ok(skillVersion?.includes(ansi(255, 158, 100, "1.0.0")), "managed Skill version uses Xeo bright yellow");
  assert.ok(appVersion?.includes(ansi(255, 158, 100, "1.0.0")), "App version uses Xeo bright yellow");
  assert.ok(packageVersion?.includes(ansi(255, 158, 100, "1.0.0")), "Package version uses Xeo bright yellow");
  assert.ok(packageVersion?.includes(ansi(255, 158, 100, "2.0.0")), "available Package version uses Xeo bright yellow");
});
