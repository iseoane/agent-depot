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
    const frame = element => { const view = render(element); const result = view.lastFrame() ?? ""; view.unmount(); return result; };
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
    const prompt = frame(React.createElement(DecisionPrompt, null, "Refresh these Sources?"));
    const header = frame(React.createElement(Header, { view: "updates", columns: 80 }));
    process.stdout.write([browse, result, failure, check, preview, prompt, header].join("\\n---\\n"));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  assert.equal(child.status, 0, child.stderr);
  const [browse, result, failure, check, preview, prompt, header] = child.stdout.split("\n---\n");
  assert.ok(browse?.includes(ansi(68, 157, 171, "skills/demo")), "browse path is cyan");
  assert.ok(browse?.includes(ansi(68, 157, 171, "user-global")), "browse scope is cyan");
  assert.ok(browse?.includes(ansi(192, 202, 245, "1.0.0")), "installed version is light");
  assert.ok(browse?.includes(ansi(192, 202, 245, "2.0.0")), "available version is light");

  assert.ok(result?.includes(ansi(158, 206, 106, "[OK]")), "success is a separate green indicator");
  assert.ok(result?.includes(ansi(68, 157, 171, "Update summary:")), "summary label is cyan");
  assert.ok(result?.includes(ansi(192, 202, 245, " 1 updated, 0 failed")), "summary value is light");
  assert.ok(result?.includes(ansi(68, 157, 171, "Updated")), "updated label is cyan");
  assert.ok(result?.includes(ansi(192, 202, 245, " App: demo: installed 1.0.0 -> 2.0.0 (latest 2.0.0)")), "update details are light");
  assert.ok(!result?.includes(ansi(158, 206, 106, "Update summary: 1 updated, 0 failed")), "success does not color the full summary green");
  assert.ok(failure?.includes(ansi(247, 118, 142, "[FAIL]")), "failure is a separate red indicator");
  assert.ok(failure?.includes(ansi(68, 157, 171, "Failed")), "failure label is cyan");
  assert.ok(failure?.includes(ansi(192, 202, 245, " App: demo: network unreachable")), "failure details are light");
  assert.ok(failure?.includes(ansi(68, 157, 171, "Update summary:")), "failed summary label is cyan");
  assert.ok(!failure?.includes(ansi(247, 118, 142, "Failed App: demo: network unreachable")), "failure does not color the full line red");
  assert.ok(check?.includes(ansi(247, 118, 142, "[FAIL]")), "check error has a separate red indicator");
  assert.ok(check?.includes(ansi(68, 157, 171, "Error (project):")), "check error field is cyan");
  assert.ok(check?.includes(ansi(192, 202, 245, " manifest exploded")), "check error value is light");

  assert.ok(preview?.includes(ansi(173, 142, 230, "Confirmation")), "panel title remains magenta");
  assert.ok(preview?.includes(ansi(68, 157, 171, "  target:")), "CLI target field label is cyan");
  assert.ok(preview?.includes(ansi(192, 202, 245, " skills/demo")), "CLI target value is light");
  assert.ok(preview?.includes(ansi(68, 157, 171, "  proposed changes:")), "CLI proposed changes label is cyan");
  assert.ok(preview?.includes(ansi(192, 202, 245, " replace 2 managed files")), "CLI proposed changes value is light");
  assert.ok(preview?.includes(ansi(255, 46, 154, "Apply 1 update? ")), "question text is fuchsia");
  assert.ok(preview?.includes(`${ansi(158, 206, 106, "y")}${ansi(86, 95, 137, "/")}${ansi(247, 118, 142, "n")}`), "confirmation keys keep green, gray and red roles");
  assert.ok(preview?.includes(ansi(86, 95, 137, " · note")), "question suffix remains gray");
  assert.ok(prompt?.includes(ansi(255, 46, 154, "Refresh these Sources?")), "shared DecisionPrompt text is fuchsia");
  assert.ok(header?.includes(ansi(255, 46, 154, "AGENT DEPOT")), "brand is bold fuchsia");
  assert.ok(header?.includes(ansi(255, 46, 154, "╭")), "header border is fuchsia");
  assert.ok(header?.includes(ansi(255, 46, 154, "  ▶ [4] Updates")), "active tab remains fuchsia");
  assert.ok(header?.includes(ansi(86, 95, 137, "[1] Sources")), "inactive tab remains gray");
});
