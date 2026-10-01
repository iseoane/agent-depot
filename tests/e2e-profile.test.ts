import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { profileFiles, profileSandbox, profileSourceUrl, seedProfileSandbox } from "./profile-e2e-fixture.js";

test("built CLI transfers Profile choices without approvals, App installs or repeated writes", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-profile-e2e-"));
  try {
    const repo = path.join(root, "repo");
    const a = await profileSandbox(path.join(root, "a"), repo);
    const b = await profileSandbox(path.join(root, "b"), repo);
    const fixture = await seedProfileSandbox(a, repo);
    const file = path.join(root, "profile.json");
    a.ok("export", "--out", file);
    const profile = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(profile.sources, [{ url: profileSourceUrl, included: true }]);
    assert.equal(profile.skills.length, 2);
    for (const skill of profile.skills) assert.deepEqual(skill.hosts, ["claude", "pi"]);
    assert.deepEqual(profile.apps.map((app: { platform: string }) => app.platform), ["linux", "windows"]);

    const empty = await profileFiles(b.root);
    const preview = b.cli("import", file);
    assert.equal(preview.status, 0, preview.output);
    assert.match(preview.output, /Import not confirmed/);
    assert.match(preview.output, /add: Source https:\/\/example.test\/profile\/source.git/);
    assert.match(preview.output, /Skill skills\/alpha[\s\S]*claude[\s\S]*pi/);
    assert.match(preview.output, /App recipe fixture-app \(linux/);
    assert.match(preview.output, /App recipe fixture-app \(windows/);
    assert.deepEqual(await profileFiles(b.root), empty);

    b.ok("import", file, "--yes");
    assert.match(b.ok("source", "list"), /https:\/\/example.test\/profile\/source.git/);
    assert.match(b.ok("source", "list"), /builtin:agent-depot/);
    for (const name of ["alpha", "agent-depot-apprecipe"]) {
      assert.match(await readFile(path.join(b.home, ".agents/skills", name, "SKILL.md"), "utf8"), new RegExp(`name: "?${name}"?`));
      assert.equal(await readlink(path.join(b.home, ".claude/skills", name)), `../../.agents/skills/${name}`);
    }
    const exported = JSON.parse(b.cli("export").stdout);
    assert.deepEqual(exported.skills, profile.skills);
    assert.deepEqual(exported.apps, profile.apps);
    const apps = b.ok("app", "list");
    assert.match(apps, /needs approval/);
    assert.doesNotMatch(apps, /\tinstalled\t/);
    await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
    const files = await profileFiles(b.root);
    assert.ok(!Object.keys(files).some(name => /app-approvals|app-installations/.test(name)));
    const repeated = b.ok("import", file, "--yes");
    assert.equal((repeated.match(/same: /g) ?? []).length, 5, repeated);
    assert.doesNotMatch(repeated, /add: |conflict: /);
    assert.deepEqual(await profileFiles(b.root), files);
  } finally { await rm(root, { recursive: true, force: true }); }
});
