import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const ansi = (red: number, green: number, blue: number, text: string) => `\u001b[38;2;${red};${green};${blue}m${text}`;

test("paged Skill previews colour indented warnings, host exposure notices and refusals", () => {
  const lines = [
    "  WARNING: this directory has no project manifest",
    "    WARNING: this Skill was adopted; removal deletes content that Agent Depot did not create",
    "    ADDITIONAL HOST EXPOSURE: this exposes the installed Skill to more hosts",
    "Cannot install demo: the Source is unavailable",
  ];
  const script = `
    import React from "react";
    import { render } from "ink-testing-library";
    import { PagedPreview } from "./dist/src/tui/panel-parts.js";
    import { previewViewport } from "./dist/src/tui/preview-window.js";
    const lines = ${JSON.stringify(lines)};
    const chrome = { title: "Preview", action: "Act", consequence: "Act? y/n" };
    const view = render(React.createElement(PagedPreview, { chrome, lines, viewport: previewViewport(lines, 0, 40, 200, chrome) }));
    process.stdout.write(view.lastFrame() ?? "");
    view.unmount();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  assert.equal(child.status, 0, child.stderr);
  for (const line of lines.slice(0, 3)) assert.ok(child.stdout.includes(ansi(224, 175, 104, line)), `${line} is warning amber`);
  assert.ok(child.stdout.includes(ansi(247, 118, 142, lines[3]!)), "a refused item is error red");
});
