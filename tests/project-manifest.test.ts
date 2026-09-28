import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AGENT_DEPOT_PACKAGE_VERSION,
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestError,
  ProjectManifestStore,
  readProjectManifest,
  writeProjectManifest,
  type ProjectManifest,
} from "../src/project-manifest.js";

function validManifest(): ProjectManifest {
  return parseProjectManifest({
    version: 1,
    skills: [
      {
        source: { kind: "builtin", id: "builtin:agent-depot" },
        path: "architecture",
        version: { policy: "latest" },
        hosts: ["pi", "claude"],
      },
      {
        source: {
          kind: "external",
          url: "https://github.com/example/skills/",
          ref: "a".repeat(40),
        },
        path: "review/code-review",
        version: { policy: "fixed", version: "a".repeat(40) },
        hosts: ["codex", "opencode"],
      },
    ],
  });
}

async function withManifestDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-manifest-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("validates a self-contained manifest for built-in and URL Sources", () => {
  const manifest = validManifest();

  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.skills[0], {
    source: { kind: "builtin", id: "builtin:agent-depot" },
    path: "architecture",
    version: { policy: "latest" },
    hosts: ["pi", "claude"],
  });
  assert.deepEqual(manifest.skills[1]?.source, {
    kind: "external",
    url: "https://github.com/example/skills",
    ref: "a".repeat(40),
  });
  assert.equal("id" in (manifest.skills[1]?.source ?? {}), false);
});

test("accepts an optional actual installation record while preserving older manifests", () => {
  const manifest = parseProjectManifest({
    version: 1,
    skills: [{
      ...validManifest().skills[0],
      installation: { path: ".claude/skills/architecture", adopted: true },
    }],
  });

  assert.deepEqual(manifest.skills[0]?.installation, {
    path: ".claude/skills/architecture",
    adopted: true,
  });
  assert.equal(validManifest().skills[0]?.installation, undefined);
  assert.throws(
    () => parseProjectManifest({
      version: 1,
      skills: [{ ...validManifest().skills[0], installation: { path: "../outside", adopted: true } }],
    }),
    /installation\.path must stay within the project/i,
  );
});

test("requires an explicit non-empty supported Host set", () => {
  const base = {
    version: 1,
    skills: [{
      source: { kind: "builtin", id: "builtin:agent-depot" },
      path: "skill",
      version: { policy: "latest" },
      hosts: ["pi"],
    }],
  };

  for (const hosts of [[], ["unknown"], ["pi", "pi"]]) {
    assert.throws(
      () => parseProjectManifest({ ...base, skills: [{ ...base.skills[0], hosts }] }),
      ProjectManifestError,
    );
  }
});

test("validates fixed/latest policies and rejects ambiguous versions", () => {
  const base = validManifest();
  const selection = base.skills[1];

  assert.deepEqual(parseProjectManifest({
    version: 1,
    skills: [{ ...selection, version: { policy: "fixed", version: "a".repeat(40) } }],
  }).skills[0]?.version, { policy: "fixed", version: "a".repeat(40) });
  assert.throws(
    () => parseProjectManifest({
      version: 1,
      skills: [{ ...selection, version: { policy: "fixed", version: "latest" } }],
    }),
    ProjectManifestError,
  );
  assert.throws(
    () => parseProjectManifest({
      version: 1,
      skills: [{ ...selection, version: { policy: "latest" } }],
    }),
    /latest with an immutable commit Source ref/i,
  );
  assert.deepEqual(parseProjectManifest({
    version: 1,
    skills: [{
      ...base.skills[0],
      version: { policy: "fixed", version: AGENT_DEPOT_PACKAGE_VERSION },
    }],
  }).skills[0]?.version, { policy: "fixed", version: AGENT_DEPOT_PACKAGE_VERSION });
  assert.throws(
    () => parseProjectManifest({
      version: 1,
      skills: [{
        ...base.skills[0],
        version: { policy: "fixed", version: `${AGENT_DEPOT_PACKAGE_VERSION}-unavailable` },
      }],
    }),
    /must equal the current Agent Depot package version.*cannot be reproduced by this package/i,
  );
});

test("fails closed on unsafe Source and skill identities", () => {
  const base = validManifest();
  const selection = base.skills[0];
  const invalidSelections = [
    { ...selection, source: { kind: "builtin", id: "wrong" } },
    { ...selection, source: { kind: "external", url: "https://example.com/skills?token=secret" } },
    { ...selection, source: { kind: "external", path: "vendor/skills" } },
    { ...selection, source: { kind: "external", path: "../outside" } },
    { ...selection, path: "." },
    { ...selection, path: "skill/.." },
    { ...selection, path: "../outside" },
    { ...selection, path: "skill\\nested" },
    { ...selection, source: { kind: "external", url: "https://example.com/skills", id: "git:registered" } },
  ];

  for (const selectionValue of invalidSelections) {
    assert.throws(
      () => parseProjectManifest({ version: 1, skills: [selectionValue] }),
      ProjectManifestError,
    );
  }
});

test("rejects unsupported root fields and duplicate Source/path selections", () => {
  const manifest = validManifest();
  const duplicate = manifest.skills[0];

  assert.throws(
    () => parseProjectManifest({ version: 1, skills: [duplicate, duplicate] }),
    ProjectManifestError,
  );
  assert.throws(
    () => parseProjectManifest({ version: 1, skills: [], globalSources: [] }),
    ProjectManifestError,
  );
  assert.throws(
    () => parseProjectManifest({
      version: 1,
      skills: [{
        source: { kind: "external", url: "https://example.com/skills", ref: "main" },
        path: "skill",
        version: { policy: "fixed", version: "c".repeat(40) },
        hosts: ["pi"],
      }],
    }),
    /must match source\.ref.*fixed policy pins/i,
  );
  assert.throws(
    () => parseProjectManifest({ version: 2, skills: [] }),
    ProjectManifestError,
  );
});

test("persists and reloads the project manifest without consulting global Source state", async () => {
  await withManifestDirectory(async (directory) => {
    const manifestPath = defaultProjectManifestPath(directory);
    const store = new ProjectManifestStore(manifestPath);
    const manifest = validManifest();

    await store.save(manifest);
    assert.equal(await readFile(manifestPath, "utf8"), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(await store.load(), manifest);
    assert.deepEqual(await readProjectManifest(manifestPath), manifest);
  });
});

test("treats a missing manifest as an empty validated selection set", async () => {
  await withManifestDirectory(async (directory) => {
    const manifest = await readProjectManifest(defaultProjectManifestPath(directory));
    assert.deepEqual(manifest, { version: 1, skills: [] });
  });
});

test("atomically replaces a manifest symlink without following its redirect", async () => {
  await withManifestDirectory(async (directory) => {
    const manifestPath = defaultProjectManifestPath(directory);
    const redirectedPath = path.join(directory, "outside.json");
    const originalContents = "must not be replaced";
    await writeFile(redirectedPath, originalContents, "utf8");
    await symlink(redirectedPath, manifestPath);

    await writeProjectManifest(manifestPath, parseProjectManifest({ version: 1, skills: [] }));

    assert.equal(await readFile(redirectedPath, "utf8"), originalContents);
    assert.equal((await lstat(manifestPath)).isSymbolicLink(), false);
    assert.deepEqual(await readProjectManifest(manifestPath), { version: 1, skills: [] });
  });
});

test("fails closed on malformed persisted JSON and preserves it", async () => {
  await withManifestDirectory(async (directory) => {
    const manifestPath = defaultProjectManifestPath(directory);
    const contents = "{not valid JSON";
    await writeFile(manifestPath, contents, "utf8");

    await assert.rejects(readProjectManifest(manifestPath), ProjectManifestError);
    assert.equal(await readFile(manifestPath, "utf8"), contents);
    await writeProjectManifest(manifestPath, parseProjectManifest({ version: 1, skills: [] }));
    assert.deepEqual(await readProjectManifest(manifestPath), { version: 1, skills: [] });
  });
});
