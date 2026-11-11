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
