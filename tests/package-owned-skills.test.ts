import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { GitSourceAccessAdapter, defaultGitSourceCachePath, sourceIdForUrl } from "../src/git-source.js";
import { bundleOwnedSkillMatcher, bundleOwnedSkillNameMatcher, discoverBundlesInSnapshot } from "../src/package-bundles.js";
import {
  assertSkillNotPackageOwned,
  loadPackageOwnedSkillFilter,
  packageOwnedSkillMatcher,
} from "../src/package-owned-skills.js";
import { runProcess } from "../src/process-runner.js";
import { NodeSourceContentAccess, type SourceContentAccess, type SourceContentFile } from "../src/skill-discovery.js";
import { executeSingleInstall, planSingleInstall, type InstallEnvironment } from "../src/skill-install.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import {
  inspectUserGlobalSkillRemoval,
  inspectUserGlobalSymlinkRemoval,
  removeUserGlobalSkill,
  scanUserGlobalSkillInventory,
} from "../src/user-global-skill-inventory.js";

const PSTACK_FIXTURE = path.resolve("tests", "fixtures", "packages", "pstack");
const BUNDLE_OWNED_PATH = "plugins/pstack/skills/poteto-mode";
const LOOSE_PATH = "loose/loose-skill";

/** No Source content: the state before the bundle exists. */
const emptyAccess: SourceContentAccess = { readSnapshot: async () => [] };

async function git(args: readonly string[]): Promise<void> {
  const result = await runProcess("git", args);
  assert.equal(result.code, 0, result.stderr);
}

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture Skill\n---\n`);
}

interface SourceFixture {
  readonly home: string;
  readonly root: string;
  readonly access: NodeSourceContentAccess;
  readonly operations: SourceOperations;
  readonly files: readonly SourceContentFile[];
}

/** One temporary user home and one temporary Source root holding the pstack bundle plus a loose Skill. */
async function withFixture<T>(prefix: string, run: (fixture: SourceFixture) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    const root = path.join(home, "source");
    await cp(PSTACK_FIXTURE, root, { recursive: true });
    await writeSkill(path.join(root, ...LOOSE_PATH.split("/")), "loose-skill");
    const access = new NodeSourceContentAccess({ builtInRoot: root });
    return await run({
      home,
      root,
      access,
      operations: createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json"), builtInRoot: root }),
      files: await access.readSnapshot(BUILT_IN_SOURCE),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("the Source snapshot carries the bundle manifests beside the Skill files", async () => {
  await withFixture("ad-pkg-owned-snapshot-", async ({ files }) => {
    const paths = files.map(file => file.path).sort();
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes(".claude-plugin/marketplace.json"));
    assert.ok(paths.includes("plugins/pstack/.claude-plugin/plugin.json"));
    assert.ok(paths.includes(`${BUNDLE_OWNED_PATH}/SKILL.md`));
    assert.ok(paths.includes(`${LOOSE_PATH}/SKILL.md`));
  });
});

test("a registered Git Source yields bundle ownership from its own snapshot", async () => {
  await withFixture("ad-pkg-owned-git-", async ({ root }) => {
    const cachePath = path.join(path.dirname(root), "cache");
    const url = "https://github.com/example/pstack.git";
    await git(["init", "--initial-branch=main", root]);
    await git(["-C", root, "add", "."]);
    await git(["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const adapter = new GitSourceAccessAdapter({
      cachePath,
      runner: {
        async run(command, args) {
          assert.equal(command, "git");
          await git(args.map(argument => argument === url ? root : argument));
        },
      },
    });
    const source = { id: sourceIdForUrl(url), kind: "git" as const, url };
    await adapter.refresh(source);

    const owned = await loadPackageOwnedSkillFilter({
      sources: [source],
      sourceContentAccess: new NodeSourceContentAccess({ gitCachePath: cachePath }),
    });
    assert.equal(owned(BUNDLE_OWNED_PATH)?.name, "pstack");
    assert.equal(owned(LOOSE_PATH), undefined);
  });
});

test("assertSkillNotPackageOwned names the Package and its Host", async () => {
  await withFixture("ad-pkg-owned-assert-", async ({ files }) => {
    const descriptors = discoverBundlesInSnapshot(files, {});
    assert.throws(
      () => assertSkillNotPackageOwned(BUNDLE_OWNED_PATH, bundleOwnedSkillMatcher(descriptors)),
      /Package-owned Skill "plugins\/pstack\/skills\/poteto-mode" is provided by the (pi|claude) Package "pstack"/,
    );
    assert.doesNotThrow(() => assertSkillNotPackageOwned(LOOSE_PATH, bundleOwnedSkillMatcher(descriptors)));
  });
});

test("the name matcher reads declared Skill names and refuses anything but a bare directory name", async () => {
  await withFixture("ad-pkg-owned-name-", async ({ files }) => {
    const owned = bundleOwnedSkillNameMatcher(discoverBundlesInSnapshot(files, {}));
    assert.equal(owned("how")?.name, "pstack");
    assert.equal(owned("old-skill"), undefined);
    assert.equal(owned(LOOSE_PATH), undefined);
    assert.equal(owned(""), undefined);
    assert.equal(owned("a\\b"), undefined);
  });
});

test("bundle ownership comes from one snapshot read per Source and matches discovery output", async () => {
  await withFixture("ad-pkg-owned-read-", async ({ access, files }) => {
    let reads = 0;
    const counting: SourceContentAccess = {
      readSnapshot: async (source) => {
        reads += 1;
        return await access.readSnapshot(source);
      },
    };
    const owned = await loadPackageOwnedSkillFilter({ sources: [BUILT_IN_SOURCE], sourceContentAccess: counting });
    assert.equal(reads, 1);

    const direct = packageOwnedSkillMatcher(discoverBundlesInSnapshot(files, {}));
    assert.equal(owned(BUNDLE_OWNED_PATH)?.name, direct(BUNDLE_OWNED_PATH)?.name);
    assert.equal(owned("how")?.name, direct("how")?.name);
    assert.equal(owned(LOOSE_PATH), undefined);
  });
});

test("a Source that cannot be read produces no exclusions and does not hide Skills", async () => {
  await withFixture("ad-pkg-owned-broken-", async ({ home }) => {
    const skill = path.join(home, ".agents", "skills", "poteto-mode");
    await writeSkill(skill, "poteto-mode");
    const warnings: string[] = [];
    const failing: SourceContentAccess = {
      readSnapshot: async () => {
        throw new Error("Git Source mirror is not available");
      },
    };
    const inventory = await scanUserGlobalSkillInventory({
      homeDirectory: home,
      managedInstallations: [],
      sources: [BUILT_IN_SOURCE],
      sourceContentAccess: failing,
      reportWarning: warning => warnings.push(warning),
    });
    assert.deepEqual(inventory.unmanaged.map(entry => entry.name), ["poteto-mode"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Skipping Package-owned Skill exclusions for Source/);
  });
});

test("the unmanaged inventory hides bundle-owned Skills and keeps a loose one", async () => {
  await withFixture("ad-pkg-owned-scan-", async ({ home, access }) => {
    await writeSkill(path.join(home, ".agents", "skills", "poteto-mode"), "poteto-mode");
    await writeSkill(path.join(home, ".agents", "skills", "loose-skill"), "loose-skill");

    const inventory = await scanUserGlobalSkillInventory({
      homeDirectory: home,
      managedInstallations: [],
      sources: [BUILT_IN_SOURCE],
      sourceContentAccess: access,
    });
    assert.deepEqual(inventory.unmanaged.map(entry => entry.name), ["loose-skill"]);
  });
});

test("removing a bundle-owned unmanaged Skill or link is refused and changes nothing", async () => {
  await withFixture("ad-pkg-owned-remove-", async ({ home, access }) => {
    const skill = path.join(home, ".agents", "skills", "poteto-mode");
    await writeSkill(skill, "poteto-mode");
    const link = path.join(home, ".claude", "skills", "how");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(path.join(home, "missing"), link, "dir");

    const options = {
      homeDirectory: home,
      managedInstallations: [],
      sources: [BUILT_IN_SOURCE],
      sourceContentAccess: access,
    };
    await assert.rejects(inspectUserGlobalSkillRemoval(skill, options), /Package-owned Skill "poteto-mode"/);
    await assert.rejects(inspectUserGlobalSymlinkRemoval(link, options), /Package-owned Skill "how"/);
    assert.equal((await lstat(skill)).isDirectory(), true);
    assert.equal((await lstat(link)).isSymbolicLink(), true);

    const inspected = await inspectUserGlobalSkillRemoval(skill, { ...options, sourceContentAccess: emptyAccess });
    await assert.rejects(removeUserGlobalSkill(inspected, options), /Package-owned Skill "poteto-mode"/);
    assert.equal((await lstat(skill)).isDirectory(), true);
  });
});

test("the CLI uninstall refuses a bundle-owned unmanaged path through the registered Source", async () => {
  await withFixture("ad-pkg-owned-uninstall-", async ({ home, root }) => {
    const url = "https://github.com/example/pstack.git";
    await git(["init", "--initial-branch=main", root]);
    await git(["-C", root, "add", "."]);
    await git(["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    // The guard's default content access resolves the Git cache from the environment.
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = path.join(home, "cache");
    try {
      const cachePath = defaultGitSourceCachePath();
      const source = { id: sourceIdForUrl(url), kind: "git" as const, url };
      await new GitSourceAccessAdapter({
        cachePath,
        runner: {
          async run(command, args) {
            assert.equal(command, "git");
            await git(args.map(argument => argument === url ? root : argument));
          },
        },
      }).refresh(source);
      const operations = createSourceOperations({ homeDirectory: home });
      await operations.addGitSource(url);
      const skill = path.join(home, ".agents", "skills", "poteto-mode");
      await writeSkill(skill, "poteto-mode");

      const errors: string[] = [];
      const dependencies = { homeDirectory: home, operations, stdout: () => undefined, stderr: (line: string) => errors.push(line) };
      assert.equal(await runCli(["uninstall", "--unmanaged-skill", skill, "--yes"], dependencies), 1);
      assert.match(errors.join("\n"), /Package-owned Skill "poteto-mode"/);
      assert.equal((await lstat(skill)).isDirectory(), true);
    } finally {
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
    }
  });
});

test("a CLI install refuses a bundle-owned Skill path and still installs a loose one", async () => {
  await withFixture("ad-pkg-owned-cli-", async ({ home, access, operations }) => {
    const output: string[] = [];
    const errors: string[] = [];
    const dependencies = {
      homeDirectory: home,
      operations,
      sourceAccess: access,
      sourceContentAccess: access,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    const install = async (skillPath: string): Promise<number> => runCli([
      "install", "--scope", "user-global", "--source", "builtin:agent-depot", "--skill", skillPath,
      "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
    ], dependencies);

    assert.equal(await install(BUNDLE_OWNED_PATH), 1);
    assert.match(errors.join("\n"), /Package-owned Skill "plugins\/pstack\/skills\/poteto-mode" is provided by the pi Package "pstack"/);
    await assert.rejects(lstat(path.join(home, ".agents", "skills", "poteto-mode")), /ENOENT/);

    assert.equal(await install(LOOSE_PATH), 0);
    assert.equal((await lstat(path.join(home, ".agents", "skills", "loose-skill"))).isDirectory(), true);
  });
});

test("a bundle discovered after the install preview blocks execution and persists no record", async () => {
  await withFixture("ad-pkg-owned-recheck-", async ({ home, access, operations }) => {
    const environment: InstallEnvironment & { sourceContentAccess?: SourceContentAccess } = {
      homeDirectory: home,
      sourceContentAccess: emptyAccess,
    };
    const plan = await planSingleInstall({
      scope: "user-global",
      sourceId: "builtin:agent-depot",
      skillPath: BUNDLE_OWNED_PATH,
      hosts: ["pi"],
      version: { policy: "latest" },
      portableV1: true,
      confirmed: true,
      overwrite: false,
      confirmAdditionalHostExposure: false,
    }, {
      operations,
      sourceAccess: access,
      environment,
      root: home,
      existing: [],
      recordedIn: "test state",
    });

    environment.sourceContentAccess = access;
    let persisted = false;
    await assert.rejects(
      executeSingleInstall(plan, async () => { persisted = true; }, () => undefined),
      /Package-owned Skill "plugins\/pstack\/skills\/poteto-mode"/,
    );
    assert.equal(persisted, false);
    await assert.rejects(lstat(path.join(home, ".agents", "skills", "poteto-mode")), /ENOENT/);
  });
});
