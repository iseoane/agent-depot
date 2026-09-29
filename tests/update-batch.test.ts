import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessUpdateBatch,
  selectUpdateBatch,
  UpdateBatchSelectionError,
  type UpdateBatchSnapshotAccess,
} from "../src/update-batch.js";
import { BUILT_IN_SOURCE } from "../src/sources.js";
import { parseProjectManifest, type ProjectSkillSelection, type ProjectSource } from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import type { Source } from "../src/sources.js";

const externalSource: Source = Object.freeze({
  id: "git:example",
  kind: "git",
  url: "https://github.com/example/skills",
});
const external: ProjectSource = Object.freeze({
  kind: "external",
  url: "https://github.com/example/skills",
});

function file(path: string, content: string): SkillTreeFile {
  return { path, content: Buffer.from(content), executable: false };
}

function selection(overrides: { readonly source: ProjectSource; readonly path: string } & Partial<Omit<ProjectSkillSelection, "source" | "path">>): ProjectSkillSelection {
  return {
    source: overrides.source,
    path: overrides.path,
    version: overrides.version ?? { policy: "latest" },
    hosts: overrides.hosts ?? ["pi"],
    ...(overrides.installation === undefined ? {} : { installation: overrides.installation }),
    ...(overrides.methods === undefined ? {} : { methods: overrides.methods }),
  };
}

function snapshotAccess(
  snapshots: ReadonlyMap<string, { readonly files: readonly SkillTreeFile[]; readonly resolvedVersion?: { kind: "builtin-package"; version: string } | { kind: "git-commit"; commit: string } }>,
): UpdateBatchSnapshotAccess {
  return {
    async readSkillTreeSnapshot(source, skillPath) {
      const snapshot = snapshots.get(`${source.id}/${skillPath}`);
      if (!snapshot) throw new Error(`missing snapshot for ${source.id}/${skillPath}`);
      return snapshot;
    },
  };
}

function installed(version: { kind: "builtin-package"; version: string } | { kind: "git-commit"; commit: string }, baseline: string) {
  return {
    path: ".agents/skills/demo",
    adopted: false,
    resolvedVersion: version,
    baseline: { algorithm: "sha256" as const, digest: baseline },
  };
}

const builtinV1 = { kind: "builtin-package" as const, version: "1.0.0" };
const builtinV2 = { kind: "builtin-package" as const, version: "2.0.0" };
const gitV1 = { kind: "git-commit" as const, commit: "1".repeat(40) };
const gitV2 = { kind: "git-commit" as const, commit: "2".repeat(40) };

function withSnapshot(
  source: Source,
  skillPath: string,
  snapshot: { readonly files: readonly SkillTreeFile[]; readonly resolvedVersion?: typeof builtinV1 | typeof builtinV2 | typeof gitV1 | typeof gitV2 },
) {
  return snapshotAccess(new Map([[`${source.id}/${skillPath}`, snapshot]]));
}

test("assesses latest built-in updates from the immutable current snapshot", async () => {
  const currentFiles = [file("demo/SKILL.md", "new")];
  const assessment = await assessUpdateBatch([
    selection({
      source: BUILT_IN_SOURCE,
      path: "demo",
      installation: installed(builtinV1, "a".repeat(64)),
    }),
  ], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: withSnapshot(BUILT_IN_SOURCE, "demo", { files: currentFiles, resolvedVersion: builtinV2 }),
  });

  assert.equal(assessment.items.length, 1);
  assert.equal(assessment.items[0]?.status, "updateable");
  assert.equal(assessment.updateable.length, 1);
  assert.equal(assessment.unknown.length, 0);
  assert.match(assessment.items[0]?.reason ?? "", /newer|changed/i);
});

test("treats a latest installation with matching version and baseline as current", async () => {
  const currentFiles = [file("demo/SKILL.md", "same")];
  const currentBaseline = skillTreeBaseline(currentFiles).digest;
  const assessment = await assessUpdateBatch([
    selection({
      source: BUILT_IN_SOURCE,
      path: "demo",
      installation: installed(builtinV2, currentBaseline),
    }),
  ], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: withSnapshot(BUILT_IN_SOURCE, "demo", { files: currentFiles, resolvedVersion: builtinV2 }),
  });

  assert.equal(assessment.items[0]?.status, "current");
});

test("uses the supplied baseline calculator and detects changed content at the same version", async () => {
  const currentFiles = [file("demo/SKILL.md", "changed")];
  const assessment = await assessUpdateBatch([
    selection({
      source: BUILT_IN_SOURCE,
      path: "demo",
      installation: installed(builtinV2, "a".repeat(64)),
    }),
  ], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: withSnapshot(BUILT_IN_SOURCE, "demo", { files: currentFiles, resolvedVersion: builtinV2 }),
  });

  assert.equal(assessment.items[0]?.status, "updateable");
  assert.notEqual(assessment.items[0]?.currentBaseline?.digest, "a".repeat(64));
});

test("fixed policy is current only at its fixed target and unknown when the source snapshot disagrees", async () => {
  const fixed = selection({
    source: external,
    path: "demo",
    version: { policy: "fixed", version: gitV2.commit },
    installation: installed(gitV2, skillTreeBaseline([file("demo/SKILL.md", "same")]).digest),
  });
  const current = await assessUpdateBatch([fixed], {
    resolveSource: async () => externalSource,
    sourceAccess: withSnapshot(externalSource, "demo", { files: [file("demo/SKILL.md", "same")], resolvedVersion: gitV2 }),
  });
  assert.equal(current.items[0]?.status, "current");

  const mismatched = await assessUpdateBatch([fixed], {
    resolveSource: async () => externalSource,
    sourceAccess: withSnapshot(externalSource, "demo", { files: [file("demo/SKILL.md", "future")], resolvedVersion: gitV1 }),
  });
  assert.equal(mismatched.items[0]?.status, "unknown");
  assert.match(mismatched.items[0]?.reason ?? "", /fixed|target/i);
});

test("a missing installation baseline is unknown even when version evidence matches", async () => {
  const currentFiles = [file("demo/SKILL.md", "same")];
  const assessment = await assessUpdateBatch([
    selection({
      source: BUILT_IN_SOURCE,
      path: "demo",
      installation: { path: ".agents/skills/demo", adopted: false, resolvedVersion: builtinV2 },
    }),
  ], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: withSnapshot(BUILT_IN_SOURCE, "demo", { files: currentFiles, resolvedVersion: builtinV2 }),
  });

  assert.equal(assessment.items[0]?.status, "unknown");
  assert.match(assessment.items[0]?.reason ?? "", /baseline/i);
  assert.deepEqual(assessment.updateable, []);
});

test("malformed runtime selections fail closed without aborting valid entries", async () => {
  const malformed = {
    source: BUILT_IN_SOURCE,
    path: "demo",
    version: null,
    hosts: ["pi"],
  } as unknown as ProjectSkillSelection;
  const valid = selection({
    source: BUILT_IN_SOURCE,
    path: "valid",
    installation: installed(builtinV1, "a".repeat(64)),
  });
  const assessment = await assessUpdateBatch([malformed, valid], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: snapshotAccess(new Map([
      [`${BUILT_IN_SOURCE.id}/valid`, { files: [file("valid/SKILL.md", "new")], resolvedVersion: builtinV2 }],
    ])),
  });

  assert.equal(assessment.items[0]?.status, "unknown");
  assert.match(assessment.items[0]?.reason ?? "", /malformed/i);
  assert.equal(assessment.items[1]?.status, "updateable");
});

test("a malformed tree snapshot does not abort independent entries", async () => {
  const malformed = selection({
    source: BUILT_IN_SOURCE,
    path: "malformed",
    installation: installed(builtinV1, "a".repeat(64)),
  });
  const valid = selection({
    source: BUILT_IN_SOURCE,
    path: "valid",
    installation: installed(builtinV1, "b".repeat(64)),
  });
  const sourceAccess: UpdateBatchSnapshotAccess = {
    async readSkillTreeSnapshot(_source, skillPath) {
      if (skillPath === "malformed") {
        return { files: null } as unknown as { files: readonly SkillTreeFile[] };
      }
      return { files: [file("valid/SKILL.md", "new")], resolvedVersion: builtinV2 };
    },
  };
  const assessment = await assessUpdateBatch([malformed, valid], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess,
  });

  assert.equal(assessment.items[0]?.status, "unknown");
  assert.match(assessment.items[0]?.reason ?? "", /snapshot|malformed/i);
  assert.equal(assessment.items[1]?.status, "updateable");
});

test("latest external selections require trustworthy installed and current version evidence", async () => {
  const sourceSnapshot = { files: [file("demo/SKILL.md", "new")], resolvedVersion: gitV2 };
  const noInstalledVersion = await assessUpdateBatch([
    selection({ source: external, path: "demo", installation: { path: ".agents/skills/demo", adopted: false, baseline: { algorithm: "sha256", digest: "a".repeat(64) } } }),
  ], { resolveSource: async () => externalSource, sourceAccess: withSnapshot(externalSource, "demo", sourceSnapshot) });
  assert.equal(noInstalledVersion.items[0]?.status, "unknown");
  assert.match(noInstalledVersion.items[0]?.reason ?? "", /version/i);

  const noCurrentVersion = await assessUpdateBatch([
    selection({ source: external, path: "demo", installation: installed(gitV1, "a".repeat(64)), methods: { update: { kind: "command", argv: ["pnpm", "update"] } } }),
  ], {
    resolveSource: async () => externalSource,
    sourceAccess: withSnapshot(externalSource, "demo", { files: sourceSnapshot.files }),
  });
  assert.equal(noCurrentVersion.items[0]?.status, "unknown");
  assert.match(noCurrentVersion.items[0]?.reason ?? "", /version/i);
});

test("legacy or uninstalled selections are unknown and never updateable", async () => {
  const assessment = await assessUpdateBatch([
    selection({ source: BUILT_IN_SOURCE, path: "missing" }),
  ], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: withSnapshot(BUILT_IN_SOURCE, "missing", { files: [file("missing/SKILL.md", "new")], resolvedVersion: builtinV2 }),
  });
  assert.equal(assessment.items[0]?.status, "unknown");
  assert.deepEqual(assessment.updateable, []);
  assert.equal(selectUpdateBatch(assessment, "all").length, 0);
});

test("assesses all entries independently and preserves input order", async () => {
  const first = selection({ source: BUILT_IN_SOURCE, path: "one", installation: installed(builtinV1, "a".repeat(64)) });
  const second = selection({ source: BUILT_IN_SOURCE, path: "two", installation: installed(builtinV2, skillTreeBaseline([file("two/SKILL.md", "two")]).digest) });
  const access = snapshotAccess(new Map([
    [`${BUILT_IN_SOURCE.id}/one`, { files: [file("one/SKILL.md", "one")], resolvedVersion: builtinV2 }],
    [`${BUILT_IN_SOURCE.id}/two`, { files: [file("two/SKILL.md", "two")], resolvedVersion: builtinV2 }],
  ]));
  const assessment = await assessUpdateBatch([first, second], { resolveSource: async () => BUILT_IN_SOURCE, sourceAccess: access });
  assert.deepEqual(assessment.items.map((item) => item.selection.path), ["one", "two"]);
  assert.deepEqual(assessment.updateable.map((item) => item.selection.path), ["one"]);
  assert.deepEqual(assessment.current.map((item) => item.selection.path), ["two"]);
});

test("selects all updateable entries or a validated subset only", async () => {
  const one = selection({ source: BUILT_IN_SOURCE, path: "one", installation: installed(builtinV1, "a".repeat(64)) });
  const two = selection({ source: BUILT_IN_SOURCE, path: "two", installation: installed(builtinV1, "b".repeat(64)) });
  const access = snapshotAccess(new Map([
    [`${BUILT_IN_SOURCE.id}/one`, { files: [file("one/SKILL.md", "one")], resolvedVersion: builtinV2 }],
    [`${BUILT_IN_SOURCE.id}/two`, { files: [file("two/SKILL.md", "two")], resolvedVersion: builtinV2 }],
  ]));
  const assessment = await assessUpdateBatch([one, two], { resolveSource: async () => BUILT_IN_SOURCE, sourceAccess: access });

  assert.deepEqual(selectUpdateBatch(assessment, { mode: "all" }).map((item) => item.id), assessment.updateable.map((item) => item.id));
  assert.deepEqual(selectUpdateBatch(assessment, { mode: "subset", ids: [assessment.updateable[1]?.id ?? ""] }).length, 1);
  for (const request of [
    { mode: "subset", ids: [] as string[] },
    { mode: "subset", ids: ["missing"] },
    { mode: "subset", ids: [assessment.unknown[0]?.id ?? ""] },
    { mode: "subset", ids: [assessment.updateable[0]?.id ?? "", assessment.updateable[0]?.id ?? ""] },
  ] as const) {
    assert.throws(() => selectUpdateBatch(assessment, request), UpdateBatchSelectionError);
  }
});

test("rejects malformed runtime mode requests instead of selecting all updateable entries", async () => {
  const updateable = selection({
    source: BUILT_IN_SOURCE,
    path: "demo",
    installation: installed(builtinV1, "a".repeat(64)),
  });
  const assessment = await assessUpdateBatch([updateable], {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: withSnapshot(BUILT_IN_SOURCE, "demo", {
      files: [file("demo/SKILL.md", "new")],
      resolvedVersion: builtinV2,
    }),
  });

  for (const request of [{ mode: "bogus" }, { mode: "subset" }] as unknown[]) {
    assert.throws(
      () => selectUpdateBatch(assessment, request as Parameters<typeof selectUpdateBatch>[1]),
      UpdateBatchSelectionError,
    );
  }
});

test("accepts a parsed project manifest without invoking a CLI or update executor", async () => {
  const manifest = parseProjectManifest({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: installed(builtinV1, "a".repeat(64)),
    }],
  });
  const assessment = await assessUpdateBatch(manifest, {
    resolveSource: async () => BUILT_IN_SOURCE,
    sourceAccess: withSnapshot(BUILT_IN_SOURCE, "demo", { files: [file("demo/SKILL.md", "new")], resolvedVersion: builtinV2 }),
  });
  assert.equal(assessment.updateable.length, 1);
});
