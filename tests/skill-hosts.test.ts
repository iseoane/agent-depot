import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProjectInstallationFileSystem } from "../src/project-installation.js";
import type { ProjectHost, ProjectSkillSelection } from "../src/project-manifest.js";
import { executeHostAddition, executeHostRemoval, planHostAddition, planHostRemoval } from "../src/skill-hosts.js";
import { userGlobalRemovalOptions } from "../src/skill-removal.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";

interface Fixture {
  readonly home: string;
  readonly operations: SourceOperations;
  readonly options: ReturnType<typeof userGlobalRemovalOptions>;
  readonly record: ProjectSkillSelection;
}

const canonical = (home: string) => path.join(home, ".agents", "skills", "one");
const claude = (home: string) => path.join(home, ".claude", "skills", "one");

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** A user-global installation of `portable/one` under a temp home; `withClaudeLink` mirrors a Claude host. */
async function withInstallation(
  hosts: readonly ProjectHost[],
  run: (fixture: Fixture) => Promise<void>,
  setup: { readonly withClaudeLink?: boolean; readonly installationPath?: string } = {},
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-hosts-home-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-hosts-state-"));
  try {
    const operations = createSourceOperations({ statePath: path.join(state, "sources.json") });
    const installationPath = setup.installationPath ?? ".agents/skills/one";
    const directory = path.join(home, ...installationPath.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "one", "utf8");
    if (setup.withClaudeLink ?? hosts.includes("claude")) {
      await mkdir(path.dirname(claude(home)), { recursive: true });
      await symlink(path.relative(path.dirname(claude(home)), canonical(home)), claude(home), "dir");
    }
    const record: ProjectSkillSelection = {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/one",
      version: { policy: "latest" },
      hosts,
      installation: { path: installationPath, adopted: false },
    };
    await operations.addUserGlobalInstallation!(record);
    await run({ home, operations, options: userGlobalRemovalOptions(home), record });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
}

const recordedHosts = async (operations: SourceOperations) => (await operations.listUserGlobalInstallations!())[0]!.hosts;

test("adding claude creates only the managed symlink and records the host", async () => {
  await withInstallation(["pi"], async ({ home, operations, options, record }) => {
    const plan = await planHostAddition(record, ["claude"], options);
    assert.match(plan.preview.join("\n"), /\.claude\/skills\/one/u);
    await executeHostAddition(plan, operations, options, await operations.listUserGlobalInstallations!(), true);
    assert.equal(await readlink(claude(home)), path.join("..", "..", ".agents", "skills", "one"));
    assert.equal(await readFile(path.join(canonical(home), "SKILL.md"), "utf8"), "one");
    assert.deepEqual(await recordedHosts(operations), ["pi", "claude"]);
  });
});

test("adding a host requires the explicit additional-host confirmation and changes nothing without it", async () => {
  await withInstallation(["pi"], async ({ home, operations, options, record }) => {
    const plan = await planHostAddition(record, ["claude"], options);
    await assert.rejects(
      executeHostAddition(plan, operations, options, await operations.listUserGlobalInstallations!(), false),
      /explicit confirmation/u,
    );
    assert.equal(await exists(claude(home)), false);
    assert.deepEqual(await recordedHosts(operations), ["pi"]);
  });
});

test("adding a host that shares the canonical location changes only the record", async () => {
  await withInstallation(["claude"], async ({ home, operations, options, record }) => {
    const plan = await planHostAddition(record, ["codex"], options);
    assert.match(plan.preview.join("\n"), /no files change/u);
    await executeHostAddition(plan, operations, options, await operations.listUserGlobalInstallations!(), true);
    assert.deepEqual(await recordedHosts(operations), ["claude", "codex"]);
    assert.ok(await exists(claude(home)));
  });
});

test("adding claude refuses a location that holds different content", async () => {
  await withInstallation(["pi"], async ({ home, options, record }) => {
    await mkdir(claude(home), { recursive: true });
    await writeFile(path.join(claude(home), "SKILL.md"), "different", "utf8");
    await assert.rejects(planHostAddition(record, ["claude"], options), /already exists/u);
    assert.equal(await readFile(path.join(claude(home), "SKILL.md"), "utf8"), "different");
  });
});

test("adding a non-claude host to a Claude-only installation is refused instead of copying", async () => {
  await withInstallation(["claude"], async ({ options, record }) => {
    await assert.rejects(planHostAddition(record, ["pi"], options), /would require copying/u);
  }, { installationPath: ".claude/skills/one", withClaudeLink: false });
});

test("adding rejects hosts that are already recorded or unknown", async () => {
  await withInstallation(["pi"], async ({ options, record }) => {
    await assert.rejects(planHostAddition(record, ["pi"], options), /already exposed to pi/u);
    await assert.rejects(planHostAddition(record, [], options), /at least one Host/u);
  });
});

test("removing claude deletes only the symlink and keeps the shared canonical Skill", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations, options, record }) => {
    const plan = await planHostRemoval(record, ["claude"], options);
    assert.equal(plan.kind, "hosts");
    await executeHostRemoval(plan, operations, options, await operations.listUserGlobalInstallations!());
    assert.equal(await exists(claude(home)), false);
    assert.equal(await readFile(path.join(canonical(home), "SKILL.md"), "utf8"), "one");
    assert.deepEqual(await recordedHosts(operations), ["pi"]);
  });
});

test("removing a shared-location host keeps every file because the canonical Skill backs the remaining hosts", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations, options, record }) => {
    const plan = await planHostRemoval(record, ["pi"], options);
    assert.equal(plan.kind, "hosts");
    assert.match(plan.preview.join("\n"), /no files are deleted/u);
    await executeHostRemoval(plan, operations, options, await operations.listUserGlobalInstallations!());
    assert.ok(await exists(claude(home)));
    assert.ok(await exists(canonical(home)));
    assert.deepEqual(await recordedHosts(operations), ["claude"]);
  });
});

test("removing every recorded host is a full removal", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations, options, record }) => {
    const plan = await planHostRemoval(record, ["claude", "pi"], options);
    assert.equal(plan.kind, "full");
    await executeHostRemoval(plan, operations, options, await operations.listUserGlobalInstallations!());
    assert.equal(await exists(claude(home)), false);
    assert.equal(await exists(canonical(home)), false);
    assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
  });
});

test("removing an unrecorded host fails before anything changes", async () => {
  await withInstallation(["pi", "claude"], async ({ home, options, record }) => {
    await assert.rejects(planHostRemoval(record, ["codex"], options), /not recorded for this Skill/u);
    await assert.rejects(planHostRemoval(record, [], options), /at least one Host/u);
    assert.ok(await exists(claude(home)));
  });
});

test("host removal rechecks the target and deletes nothing when it changed after the plan", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations, options, record }) => {
    const plan = await planHostRemoval(record, ["claude"], options);
    await writeFile(path.join(canonical(home), "SKILL.md"), "changed", "utf8");
    await assert.rejects(
      executeHostRemoval(plan, operations, options, await operations.listUserGlobalInstallations!()),
      /changed/u,
    );
    assert.ok(await exists(claude(home)));
    assert.deepEqual(await recordedHosts(operations), ["pi", "claude"]);
  });
});

test("removing claude from a Claude-only real directory installation is refused", async () => {
  await withInstallation(["pi", "claude"], async ({ options, record }) => {
    await assert.rejects(
      planHostRemoval({ ...record, installation: { path: ".claude/skills/one", adopted: true } }, ["claude"], options),
      /only copy/u,
    );
  }, { installationPath: ".claude/skills/one", withClaudeLink: false });
});

/** A real-filesystem adapter whose individual operations can be overridden per test. */
function realFileSystem(overrides: Partial<ProjectInstallationFileSystem> = {}): ProjectInstallationFileSystem {
  return {
    lstat,
    readdir: async (candidate) => readdir(candidate),
    readFile: async (candidate) => readFile(candidate),
    mkdir: async (candidate) => {
      await mkdir(candidate);
    },
    writeFile: async (candidate, content) => {
      await writeFile(candidate, content, { flag: "wx" });
    },
    chmod,
    symlink: async (target, candidate, type) => {
      await symlink(target, candidate, type);
    },
    rename,
    readlink,
    rm: async (candidate) => {
      await rm(candidate, { recursive: true, force: true });
    },
    rmdir,
    unlink,
    ...overrides,
  };
}

const failingUpdate = (message: string): Partial<SourceOperations> => ({
  updateUserGlobalInstallation: async () => {
    throw new Error(message);
  },
});

test("adding claude removes the new symlink again when the record update fails", async () => {
  await withInstallation(["pi"], async ({ home, operations, options, record }) => {
    const plan = await planHostAddition(record, ["claude"], options);
    const failing = { ...operations, ...failingUpdate("record write failed") } as SourceOperations;
    await assert.rejects(
      executeHostAddition(plan, failing, options, await operations.listUserGlobalInstallations!(), true),
      /record write failed/u,
    );
    await assert.rejects(lstat(claude(home)), { code: "ENOENT" });
    assert.deepEqual(await recordedHosts(operations), ["pi"]);
  });
});

test("adding claude reports both errors when the record update and the rollback fail", async () => {
  await withInstallation(["pi"], async ({ home, operations }) => {
    const options = userGlobalRemovalOptions(home, {
      fileSystem: realFileSystem({
        rm: async (candidate) => {
          if (candidate === claude(home)) throw new Error("rm denied");
          await rm(candidate, { recursive: true, force: true });
        },
      }),
    });
    const record = (await operations.listUserGlobalInstallations!())[0]!;
    const plan = await planHostAddition(record, ["claude"], options);
    const failing = { ...operations, ...failingUpdate("record write failed") } as SourceOperations;
    await assert.rejects(
      executeHostAddition(plan, failing, options, await operations.listUserGlobalInstallations!(), true),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /record write failed/u);
        assert.match(message, /rm denied/u);
        return true;
      },
    );
  });
});

test("adding claude refuses a foreign symlink at the claude location and leaves it untouched", async () => {
  await withInstallation(["pi"], async ({ home, options, record }) => {
    await mkdir(path.dirname(claude(home)), { recursive: true });
    await symlink("/somewhere/else", claude(home), "dir");
    await assert.rejects(planHostAddition(record, ["claude"], options), /already exists/u);
    assert.equal(await readlink(claude(home)), "/somewhere/else");
  });
});

test("removing claude refuses a foreign symlink at the claude location and leaves it untouched", async () => {
  await withInstallation(["pi", "claude"], async ({ home, options, record }) => {
    await rm(claude(home));
    await symlink("/somewhere/else", claude(home), "dir");
    await assert.rejects(planHostRemoval(record, ["claude"], options), /does not point to the canonical/u);
    assert.equal(await readlink(claude(home)), "/somewhere/else");
  });
});

test("removing claude replaced by a foreign symlink after the plan deletes nothing", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations, options, record }) => {
    const plan = await planHostRemoval(record, ["claude"], options);
    await rm(claude(home));
    await symlink("/somewhere/else", claude(home), "dir");
    await assert.rejects(executeHostRemoval(plan, operations, options, await operations.listUserGlobalInstallations!()));
    assert.equal(await readlink(claude(home)), "/somewhere/else");
    assert.deepEqual(await recordedHosts(operations), ["pi", "claude"]);
  });
});

test("removing claude deletes the symlink without a recursive removal", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations }) => {
    const options = userGlobalRemovalOptions(home, {
      fileSystem: realFileSystem({
        rm: async (candidate) => {
          throw new Error(`recursive rm must not be used for ${candidate}`);
        },
      }),
    });
    const record = (await operations.listUserGlobalInstallations!())[0]!;
    const plan = await planHostRemoval(record, ["claude"], options);
    await executeHostRemoval(plan, operations, options, await operations.listUserGlobalInstallations!());
    assert.equal(await exists(claude(home)), false);
    assert.equal(await readFile(path.join(canonical(home), "SKILL.md"), "utf8"), "one");
  });
});

test("removing claude refuses to unlink a path that became a real directory just before deletion", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations }) => {
    let claudeLstats = 0;
    const options = userGlobalRemovalOptions(home, {
      fileSystem: realFileSystem({
        lstat: async (candidate) => {
          // Execution inspects the claude path twice (recheck, then removal recheck); swap it right before the third look.
          if (candidate === claude(home) && ++claudeLstats === 3) {
            await rm(claude(home));
            await mkdir(claude(home));
            await writeFile(path.join(claude(home), "keep.txt"), "keep", "utf8");
          }
          return lstat(candidate);
        },
      }),
    });
    const record = (await operations.listUserGlobalInstallations!())[0]!;
    const plan = await planHostRemoval(record, ["claude"], options);
    claudeLstats = 0;
    await assert.rejects(executeHostRemoval(plan, operations, options, await operations.listUserGlobalInstallations!()), /symlink/u);
    assert.equal(claudeLstats, 3);
    assert.equal(await readFile(path.join(claude(home), "keep.txt"), "utf8"), "keep");
    assert.deepEqual(await recordedHosts(operations), ["pi", "claude"]);
  });
});

test("removing claude explains how to recover when the record update fails after the symlink is gone", async () => {
  await withInstallation(["pi", "claude"], async ({ home, operations, options, record }) => {
    const plan = await planHostRemoval(record, ["claude"], options);
    const failing = { ...operations, ...failingUpdate("record write failed") } as SourceOperations;
    await assert.rejects(
      executeHostRemoval(plan, failing, options, await operations.listUserGlobalInstallations!()),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /record write failed/u);
        assert.match(message, /was not updated/u);
        assert.match(message, /skill remove "portable\/one" --host claude/u);
        return true;
      },
    );
    assert.equal(await exists(claude(home)), false);
    assert.deepEqual(await recordedHosts(operations), ["pi", "claude"]);
    // The advertised recovery works: the missing symlink is tolerated and the record is reconciled.
    const retry = await planHostRemoval((await operations.listUserGlobalInstallations!())[0]!, ["claude"], options);
    await executeHostRemoval(retry, operations, options, await operations.listUserGlobalInstallations!());
    assert.deepEqual(await recordedHosts(operations), ["pi"]);
  });
});
