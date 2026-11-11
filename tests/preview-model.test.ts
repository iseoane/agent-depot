import assert from "node:assert/strict";
import { test } from "node:test";

import { commandLine } from "../src/preview-model.js";

test("a command line quotes only the arguments a shell could read differently", () => {
  assert.equal(commandLine(["pacman", "-Syu", "ripgrep", "--root=/usr/local", "user@host:1.2"]), "pacman -Syu ripgrep --root=/usr/local user@host:1.2");
  assert.equal(commandLine(["demo", "two words", "", "it's", 'say "hi"']), 'demo "two words" "" "it\'s" "say \\"hi\\""');
  for (const special of ["$HOME", "a;b", "a|b", "a&b", "a>b", "a<b", "(a)", "*", "a?", "[a]", "{a}", "~", "#x", "!x", "`x`", "a\\b", "tab\there"]) {
    assert.equal(commandLine(["x", special]), `x ${JSON.stringify(special)}`, special);
  }
});

test("a command line escapes invisible, format and control characters so one argument cannot look like another", () => {
  assert.equal(commandLine(["x", "a\u202Eb"]), 'x "a\\u202eb"');
  assert.equal(commandLine(["x", "zero\u200Bwidth"]), 'x "zero\\u200bwidth"');
  assert.equal(commandLine(["x", "del\u007F", "next\u0085line", "sep\u2028arator"]), 'x "del\\u007f" "next\\u0085line" "sep\\u2028arator"');
  assert.equal(commandLine(["x", "tag\u{E0041}"]), 'x "tag\\u{e0041}"');
  assert.equal(commandLine(["\u202Erm", "-rf"]), '"\\u202erm" -rf');
});
