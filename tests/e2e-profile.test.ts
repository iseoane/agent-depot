import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAppOperations } from "../src/app-flow.js";
import { buildProfileExport, writeProfileExport } from "../src/profile-export.js";
import { applyProfileImport, buildProfileImport } from "../src/profile-import.js";
import { createPackageSide, hostedSelection } from "./profile-package-fixture.js";
import { profileFiles, profileSandbox, profileSourceUrl, seedProfileSandbox } from "./profile-e2e-fixture.js";

test("built CLI transfers Profile choices without approvals, App installs or repeated writes", { skip: process.platform !== "linux" }, async () => {  const root = await mkdtemp(path.join(tmpdir(), "depot-profile-e2e-"));
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

/**
 * The Source snapshot is a fixture and no network runs, while the state store,
 * its receipts, the profile file and the sandbox tree are all real.
 */
test("Profile files carry a Package selection through the real state layout without a host command", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-profile-packages-e2e-"));
  try {
    const repo = path.join(root, "unused-repo");
    const a = await profileSandbox(path.join(root, "a"), repo);
    const source = await createPackageSide({ homeDirectory: a.home, stateDirectory: path.join(a.root, "state", "agent-depot") });
    const apps = createAppOperations({ recipesDirectory: path.join(a.home, "apps") });
    const chosen = await source.operations.planLifecycle(hostedSelection, "select");
    await source.operations.approve(hostedSelection, "select");
    assert.equal((await source.operations.executeLifecycle(chosen, true)).status, "selected");
    const file = path.join(root, "package-profile.json");
    const exported = await buildProfileExport(source.sourceOperations, apps,
      { homeDirectory: a.home, packageOperations: source.operations });
    await writeProfileExport(file, exported.profile);
    const text = await readFile(file, "utf8");
    const profile = JSON.parse(text);
    assert.deepEqual(profile.packages, [hostedSelection]);
    assert.doesNotMatch(text, /[0-9a-f]{64}/);

    const b = await profileSandbox(path.join(root, "b"), repo);
    const target = await createPackageSide({ homeDirectory: b.home, stateDirectory: path.join(b.root, "state", "agent-depot"),
      bundleVersion: "2.0.0" });
    const targetApps = createAppOperations({ recipesDirectory: path.join(b.home, "apps") });
    const plan = await buildProfileImport(profile, target.sourceOperations, targetApps, {}, target.operations);
    assert.deepEqual(plan.packages.map(item => [item.label, item.status]), [["Package pi . (latest)", "add"]]);
    const results = await applyProfileImport(plan, target.sourceOperations, targetApps, true, () => {},
      { homeDirectory: b.home, packageOperations: target.operations });
    assert.deepEqual(results.map(result => [result.item.block, result.status]), [["sources", "skipped"], ["packages", "added"]]);
    assert.deepEqual(target.calls, []);

    const stateFiles = await profileFiles(path.join(b.root, "state"));
    const names = Object.keys(stateFiles).sort();
    assert.equal(names.length, 2);
    assert.match(names[0]!, /^agent-depot\/package-approvals\/[0-9a-f]{64}\.json$/u);
    assert.equal(names[1], "agent-depot/packages.json");
    const receipt = names[0]!;
    const receiptContent = JSON.parse(Buffer.from(stateFiles[receipt]!.content, "base64").toString("utf8"));
    assert.deepEqual(Object.keys(receiptContent), ["version", "digest"]);
    assert.equal(receiptContent.digest, path.basename(receipt, ".json"));
    assert.doesNotMatch(text, new RegExp(receiptContent.digest));
    const state = JSON.parse(Buffer.from(stateFiles["agent-depot/packages.json"]!.content, "base64").toString("utf8"));
    assert.deepEqual(state.packages.map((record: { selection: unknown }) => record.selection), [hostedSelection]);
    // The destination re-observed its own snapshot (2.0.0), not the exporter's 1.0.0.
    assert.deepEqual(state.packages[0].verified, { kind: "manifest-version", version: "2.0.0", declaredBy: "bundle" });
    assert.doesNotMatch(text, /1\.0\.0/);

    const after = await profileFiles(b.root);
    const repeated = await applyProfileImport(
      await buildProfileImport(profile, target.sourceOperations, targetApps, {}, target.operations),
      target.sourceOperations, targetApps, true, () => {}, { homeDirectory: b.home, packageOperations: target.operations });
    assert.deepEqual(repeated.map(result => result.status), ["skipped", "skipped"]);
    assert.deepEqual(await profileFiles(b.root), after);
  } finally { await rm(root, { recursive: true, force: true }); }
});
