import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { writeFileAtomically } from "../src/atomic-file.js";

test("concurrent atomic writes to one file all succeed and leave one complete file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-atomic-"));
  try {
    const file = path.join(directory, "receipt.json");
    for (let round = 0; round < 40; round += 1) {
      const contents = Array.from({ length: 8 }, (_, writer) => `{"round":${round},"writer":${writer}}`);
      await Promise.all(contents.map((body) => writeFileAtomically(file, body)));
      assert.ok(contents.includes(await readFile(file, "utf8")));
    }
    assert.deepEqual(await readdir(directory), ["receipt.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
