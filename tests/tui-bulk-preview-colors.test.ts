import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const ansi = (red: number, green: number, blue: number, text: string) => `\u001b[38;2;${red};${green};${blue}m${text}`;

test("a bulk confirmation shows each item label in the group colour and keeps the other lines' colours", () => {
  const mode = {
    kind: "confirm-bulk-hosts",
    cursor: 0,
    plan: {
      items: [{ id: "a", label: "portable/alpha", prepared: { preview: ["  target: skills/alpha", "  WARNING: exposes more hosts"] } }],
      skipped: [{ id: "b", label: "portable/beta", reason: "no hosts left to add" }],
      installations: [],
    },
  };
  const script = `
    import React from "react";
    import { render } from "ink-testing-library";
    import { PagedConfirmPanel } from "./dist/src/tui/manage-panel.js";
    const view = render(React.createElement(PagedConfirmPanel, { mode: ${JSON.stringify(mode)} }));
    process.stdout.write(view.lastFrame() ?? "");
    view.unmount();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.includes(ansi(122, 162, 247, "portable/alpha")), "the item label uses the group colour");
  assert.ok(child.stdout.includes(ansi(192, 202, 245, " skills/alpha")), "field lines keep their inferred colours");
  assert.ok(child.stdout.includes(ansi(224, 175, 104, "  WARNING: exposes more hosts")), "warnings keep their colour");
  assert.ok(child.stdout.includes(ansi(224, 175, 104, "Skipped portable/beta: no hosts left to add")), "skipped lines keep the warning colour");
});
