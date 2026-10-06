import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { selectionKey, type InstalledPackage, type PackageSelection } from "../src/package-model.js";
import {
  PackageApprovalDigestError,
  PackageStateError,
  PackageStateStore,
  defaultPackageStateDirectory,
} from "../src/package-state.js";
import type { VersionPolicy } from "../src/project-manifest.js";

const run = promisify(execFile);
const GIT_URL = "https://github.com/example/pstack.git";
const source = { kind: "external", url: GIT_URL } as const;
const builtInSource = { kind: "builtin", id: "builtin:agent-depot" } as const;
const VERIFIED_AT = "2026-01-01T00:00:00.000Z";

function piSelection(root = "", version: VersionPolicy = { policy: "latest" }): PackageSelection {
  return { host: "pi", root, source, version };
}

function builtInSelection(root: string, version: VersionPolicy = { policy: "latest" }): PackageSelection {
  return { host: "pi", root, source: builtInSource, version };
}

function claudeSelection(marketplaceRoot = "", pluginName = "pstack"): PackageSelection {
  return { host: "claude", marketplaceRoot, pluginName, source, version: { policy: "latest" } };
}

function installed(selection: PackageSelection, installId: string): InstalledPackage {
  return { selection, installId, verifiedAt: VERIFIED_AT };
}

function statePath(directory: string): string {
  return path.join(directory, "packages.json");
}

function receiptPath(directory: string, digest: string): string {
  return path.join(directory, "package-approvals", `${digest}.json`);
}

async function withState<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-package-state-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readBytes(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined);
}

async function pathType(candidate: string): Promise<string | undefined> {
  try {
    const information = await stat(candidate);
    return information.isDirectory() ? "directory" : "file";
  } catch {
    return undefined;
  }
}

const validRecord = {
  selection: { host: "pi", root: "p", source: { kind: "external", url: GIT_URL }, version: { policy: "latest" } },
  installId: "install-1",
  verifiedAt: VERIFIED_AT,
};

test("a fresh state directory lists nothing and never creates the state file", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);

    assert.equal(store.path, statePath(directory));
    assert.equal(store.approvalsDirectory, path.join(directory, "package-approvals"));
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.find(piSelection()), undefined);

    await store.reconcile([]);
    await store.drop(piSelection());
    assert.equal(await readBytes(statePath(directory)), undefined);
  });
});

test("a record round-trips and an upsert replaces the record for the same selection", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const selection = builtInSelection("packages/pstack");

    await store.upsert(installed(selection, "install-1"));
    await store.upsert({
      ...installed(selection, "install-2"),
      lastDelegatedCommit: "a".repeat(40),
      verified: { kind: "git-commit", commit: "a".repeat(40) },
    });

    const reloaded = await new PackageStateStore(directory).find(selection);
    assert.equal(reloaded?.installId, "install-2");
    assert.deepEqual(reloaded?.verified, { kind: "git-commit", commit: "a".repeat(40) });

    // The version policy is not identity: a changed policy still replaces one record.
    await store.upsert(installed(builtInSelection("packages/pstack", { policy: "fixed", version: "0.1.0" }), "install-3"));
    assert.equal((await store.list()).length, 1);

    const contents = await readFile(statePath(directory), "utf8");
    assert.equal(JSON.parse(contents).version, 1);
    assert.ok(contents.endsWith("\n"));
  });
});

test("the store stamps one ISO verification time per write and ignores a caller's", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const attempted: InstalledPackage = {
      selection: piSelection("p"),
      installId: "install-1",
      verifiedAt: "1999-01-01T00:00:00.000Z",
    };

    await store.upsert(attempted);

    const [stored] = await store.list();
    assert.ok(stored);
    assert.notEqual(stored.verifiedAt, attempted.verifiedAt);
    assert.equal(new Date(stored.verifiedAt).toISOString(), stored.verifiedAt);
  });
});

test("a non-canonical root or a multi-segment plugin name fails closed", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const invalid: readonly InstalledPackage[] = [
      installed(piSelection("."), "dot-root"),
      installed(piSelection("./packages"), "dot-slash-root"),
      installed(piSelection("packages/"), "trailing-slash-root"),
      installed(claudeSelection("", "../escape"), "escaping-plugin"),
      installed(claudeSelection("", "nested/plugin"), "nested-plugin"),
    ];

    for (const record of invalid) {
      await assert.rejects(store.upsert(record), PackageStateError);
    }
    assert.equal(await readBytes(statePath(directory)), undefined);
  });
});

test("findAffected returns the records for one coordinate across both host arms", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    await store.upsert(installed(piSelection("packages/p"), "install-pi"));
    await store.upsert(installed(claudeSelection(), "install-claude"));
    await store.upsert(installed(piSelection("packages/q"), "install-other"));

    const pi = await store.findAffected({ host: "pi", root: "packages/p" });
    assert.deepEqual(pi.map((record) => record.installId), ["install-pi"]);
    const claude = await store.findAffected({ host: "claude", marketplaceRoot: "", pluginName: "pstack" });
    assert.deepEqual(claude.map((record) => record.installId), ["install-claude"]);
    assert.deepEqual(await store.findAffected({ host: "pi", root: "packages/missing" }), []);
  });
});

test("a raw caller spelling is canonicalized once, so the record still resolves", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const canonical = "https://github.com/example/pstack";
    const raw: PackageSelection = {
      ...piSelection("p"),
      source: { kind: "external", url: "https://GitHub.com/example/pstack/" },
    };

    await store.upsert(installed(raw, "install-1"));

    assert.equal((await store.find(raw))?.installId, "install-1");
    assert.equal((await store.find({ ...raw, source: { kind: "external", url: canonical } }))?.installId, "install-1");
    const persisted: { packages: { selection: { source: { url: string } } }[] } =
      JSON.parse(await readFile(statePath(directory), "utf8"));
    assert.equal(persisted.packages[0]?.selection.source.url, canonical);

    await store.drop(raw);
    assert.deepEqual(await store.list(), []);
  });
});

test("records for different coordinates or Sources stay separate and are stored in key order", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const selections = [
      piSelection("z-last"),
      claudeSelection(),
      piSelection("a-first"),
      { ...piSelection("z-last"), source: { ...source, url: "https://github.com/example/other.git" } },
    ];
    for (const [index, selection] of selections.entries()) {
      await store.upsert(installed(selection, `install-${index}`));
    }

    const records = await store.list();
    assert.equal(records.length, selections.length);
    assert.ok(await store.find(claudeSelection()));
    const keys = records.map((record) => selectionKey(record.selection));
    assert.deepEqual(keys, [...keys].sort());
    const persisted = JSON.parse(await readFile(statePath(directory), "utf8")) as { packages: unknown[] };
    assert.equal(persisted.packages.length, selections.length);
  });
});

test("reconcile applies keyed upserts and drops in one window", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const kept = piSelection("kept");
    const dropped = piSelection("dropped");

    await store.reconcile([
      { kind: "upsert", record: installed(kept, "kept-1") },
      { kind: "upsert", record: installed(dropped, "dropped-1") },
    ]);
    await store.reconcile([
      { kind: "upsert", record: installed(kept, "kept-2") },
      { kind: "upsert", record: installed(piSelection("added"), "added-1") },
      { kind: "drop", selection: dropped },
    ]);

    const records = await store.list();
    assert.deepEqual(records.map((record) => record.installId).sort(), ["added-1", "kept-2"]);
  });
});

test("corrupted state fails closed and the file is never rewritten", async () => {
  const corruptions: readonly (readonly [name: string, contents: string])[] = [
    ["malformed JSON", "{"],
    ["an unknown root field", JSON.stringify({ version: 1, packages: [], extra: true })],
    ["an unsupported version", JSON.stringify({ version: 2, packages: [] })],
    ["an unsupported record field", JSON.stringify({ version: 1, packages: [{ ...validRecord, extra: true }] })],
    ["a duplicate selection", JSON.stringify({ version: 1, packages: [validRecord, { ...validRecord, installId: "install-2" }] })],
    ["a non-ISO verifiedAt", JSON.stringify({ version: 1, packages: [{ ...validRecord, verifiedAt: "yesterday" }] })],
    ["a non-canonical root", JSON.stringify({
      version: 1,
      packages: [{ ...validRecord, selection: { ...validRecord.selection, root: "." } }],
    })],
    ["a Claude selection without a plugin name", JSON.stringify({
      version: 1,
      packages: [{
        selection: { host: "claude", marketplaceRoot: "", source: validRecord.selection.source, version: { policy: "latest" } },
        installId: "install-1",
        verifiedAt: VERIFIED_AT,
      }],
    })],
    ["an escaping coordinate", JSON.stringify({
      version: 1,
      packages: [{ ...validRecord, selection: { ...validRecord.selection, root: "../escape" } }],
    })],
  ];

  await withState(async (directory) => {
    for (const [name, contents] of corruptions) {
      await writeFile(statePath(directory), contents, "utf8");
      const store = new PackageStateStore(directory);

      await assert.rejects(store.list(), PackageStateError, name);
      await assert.rejects(store.upsert(installed(piSelection("new"), "new-1")), PackageStateError, name);
      assert.equal(await readFile(statePath(directory), "utf8"), contents, name);
    }
  });
});

test("a caller record that fails validation is refused before any write", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const invalid: readonly InstalledPackage[] = [
      installed(piSelection("p"), ""),
      { ...installed(piSelection("p"), "install-1"), lastDelegatedCommit: "not-a-commit" },
      { ...installed(piSelection("p"), "install-1"), verified: { kind: "git-commit", commit: "not-a-commit" } },
      installed(piSelection("../escape"), "escape-1"),
      installed({ ...piSelection("p"), version: { policy: "fixed", version: "a".repeat(40) } }, "pin-1"),
    ];

    for (const record of invalid) {
      await assert.rejects(store.upsert(record), PackageStateError);
      assert.equal(await readBytes(statePath(directory)), undefined);
    }

    // A fixed policy is valid when its Source ref pins the same commit.
    const pinned: PackageSelection = {
      ...piSelection("pinned"),
      source: { ...source, ref: "a".repeat(40) },
      version: { policy: "fixed", version: "a".repeat(40) },
    };
    await store.upsert(installed(pinned, "pinned-1"));
    assert.equal((await store.find(pinned))?.installId, "pinned-1");
  });
});

test("concurrent writers in one process converge without losing a record", async () => {
  await withState(async (directory) => {
    const selections = Array.from({ length: 12 }, (_, index) => piSelection(`parallel/${index}`));

    await Promise.all(selections.map((selection, index) =>
      new PackageStateStore(directory).upsert(installed(selection, `install-${index}`))));

    const records = await new PackageStateStore(directory).list();
    assert.equal(records.length, selections.length);
    assert.equal(await pathType(`${statePath(directory)}.lock`), undefined);
    assert.deepEqual(await readdir(directory), ["packages.json"]);
  });
});

test("concurrent writers in separate processes converge without corrupting the file", async () => {
  await withState(async (directory) => {
    const child = [
      'const { PackageStateStore } = await import(process.env.STATE_MODULE);',
      "const store = new PackageStateStore(process.env.STATE_PATH);",
      'const source = { kind: "external", url: "https://github.com/example/pstack.git" };',
      'const selection = (root) => ({ host: "pi", root, source, version: { policy: "latest" } });',
      "for (let index = 0; index < 4; index += 1) {",
      "  const root = `child-${process.env.STATE_CHILD}/pkg-${index}`;",
      `  await store.upsert({ selection: selection(root), installId: root, verifiedAt: "${VERIFIED_AT}" });`,
      "}",
      'await store.upsert({ selection: selection("shared/pkg"), installId: `child-${process.env.STATE_CHILD}-shared`, verifiedAt: "' + VERIFIED_AT + '" });',
    ].join("\n");

    const children = Array.from({ length: 4 }, (_, index) => run(process.execPath, ["--input-type=module", "-e", child], {
      env: {
        ...process.env,
        STATE_MODULE: new URL("../src/package-state.js", import.meta.url).href,
        STATE_PATH: directory,
        STATE_CHILD: String(index),
      },
    }));
    const writers = Array.from({ length: 4 }, (_, index) =>
      new PackageStateStore(directory).upsert(installed(piSelection(`parent/pkg-${index}`), `parent-${index}`)));

    await Promise.all([...children, ...writers]);

    const records = await new PackageStateStore(directory).list();
    const roots = records.flatMap((record) => (record.selection.host === "pi" ? [record.selection.root] : []));
    assert.equal(records.length, 21);
    assert.equal(new Set(roots).size, 21);
    assert.equal(roots.filter((root) => root === "shared/pkg").length, 1);
    const shared = records.find((record) => record.selection.host === "pi" && record.selection.root === "shared/pkg");
    assert.match(shared?.installId ?? "", /^child-[0-3]-shared$/);

    const contents = await readFile(statePath(directory), "utf8");
    assert.equal(JSON.parse(contents).version, 1);
    assert.equal(await pathType(`${statePath(directory)}.lock`), undefined);
    assert.deepEqual(await readdir(directory), ["packages.json"]);
  });
});

test("a receipt approves only its own digest, and a restored receipt approves again", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const approved = "a".repeat(64);
    const changed = "b".repeat(64);

    assert.equal(await store.approvalStatus(approved), "needs approval");
    await store.approve(approved);
    assert.equal(await store.approvalStatus(approved), "approved");

    // A changed declaration has a different digest and needs renewed approval.
    assert.equal(await store.approvalStatus(changed), "needs approval");
    await store.approve(changed);
    assert.equal(await store.approvalStatus(changed), "approved");
    assert.equal(await store.approvalStatus(approved), "approved");

    // Restoring the receipt bytes restores the approval.
    const receipt = await readFile(receiptPath(directory, approved), "utf8");
    await rm(receiptPath(directory, approved));
    assert.equal(await store.approvalStatus(approved), "needs approval");
    await writeFile(receiptPath(directory, approved), receipt, { mode: 0o600 });
    assert.equal(await store.approvalStatus(approved), "approved");

    assert.equal(await store.approvalStatus("A".repeat(64)), "approved");
  });
});

test("a malformed, mismatched or renamed receipt needs approval instead of throwing", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const digest = "a".repeat(64);
    const body = receiptPath(directory, digest);
    await mkdir(path.dirname(body), { recursive: true });

    const fragments = [
      "{",
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, digest: "b".repeat(64) }),
      JSON.stringify({ version: 1, digest, extra: true }),
      JSON.stringify(["not", "an", "object"]),
    ];
    for (const fragment of fragments) {
      await writeFile(body, fragment, "utf8");
      assert.equal(await store.approvalStatus(digest), "needs approval", fragment);
    }
  });
});

test("an invalid digest is refused before the filesystem is touched", async () => {
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const invalid = ["../escape", "a".repeat(63), "z".repeat(64), ""];

    for (const digest of invalid) {
      await assert.rejects(store.approve(digest), PackageApprovalDigestError);
      await assert.rejects(store.approvalStatus(digest), PackageApprovalDigestError);
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test("receipts are 0600 inside a 0700 directory even when both already exist looser", async () => {
  if (process.platform === "win32") return;
  await withState(async (directory) => {
    const store = new PackageStateStore(directory);
    const digest = "c".repeat(64);
    const body = receiptPath(directory, digest);
    await mkdir(store.approvalsDirectory, { recursive: true, mode: 0o755 });
    await writeFile(body, "stale", { mode: 0o644 });

    await store.approve(digest);

    assert.equal((await stat(store.approvalsDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(body)).mode & 0o777, 0o600);
    assert.equal(await store.approvalStatus(digest), "approved");
  });
});

test("a credentialed Source URL cannot reach the error message", async () => {
  await withState(async (directory) => {
    await writeFile(statePath(directory), JSON.stringify({
      version: 1,
      packages: [{
        selection: {
          host: "pi",
          root: "p",
          source: { kind: "external", url: "https://user:secret@example.com/x.git" },
          version: { policy: "latest" },
        },
        installId: "install-1",
        verifiedAt: VERIFIED_AT,
      }],
    }), "utf8");

    await assert.rejects(new PackageStateStore(directory).list(), (error: unknown) => {
      assert.ok(error instanceof PackageStateError);
      assert.doesNotMatch(error.message, /secret/u);
      assert.doesNotMatch(error.message, /user:secret/u);
      return true;
    });
  });
});

test("uses portable per-user state locations under the Source state directory", () => {
  assert.equal(
    defaultPackageStateDirectory({ XDG_STATE_HOME: "/state" }, "linux", "/home/alice"),
    "/state/agent-depot",
  );
  assert.equal(
    defaultPackageStateDirectory({}, "linux", "/home/alice"),
    "/home/alice/.local/state/agent-depot",
  );
  assert.equal(
    defaultPackageStateDirectory({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32", "C:\\Users\\alice"),
    "C:\\Users\\alice\\AppData\\Roaming\\Agent Depot",
  );
  assert.equal(new PackageStateStore("/tmp/agent-depot-package-test").path, "/tmp/agent-depot-package-test/packages.json");
});

test("package-state.ts is the only module that names the state file or the receipts directory", async () => {
  const sourceDirectory = new URL("../src/", import.meta.url);
  const files = (await readdir(sourceDirectory, { recursive: true })).filter((file) => file.endsWith(".js"));
  assert.ok(files.length > 0);

  const writers: string[] = [];
  for (const file of files) {
    if (file === "package-state.js") continue;
    const contents = await readFile(new URL(file, sourceDirectory), "utf8");
    if (contents.includes("packages.json") || contents.includes("package-approvals")) {
      writers.push(file);
    }
  }
  assert.deepEqual(writers, []);
});
