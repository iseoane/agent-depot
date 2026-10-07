import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPackageOperations, type PackageOperations } from "../src/package-flow.js";
import type { PiCheckoutEvidence } from "../src/package-host-state.js";
import type { GitSource } from "../src/git-source.js";
import type { PackageLifecyclePlan, PackageSelection } from "../src/package-model.js";
import type { ProcessRunOptions, ProcessRunResult } from "../src/process-runner.js";
import type { ProjectSkillSelection } from "../src/project-manifest.js";
import type { SourceContentAccess, SourceContentFile } from "../src/skill-discovery.js";
import { SourceStateStore } from "../src/source-state.js";
import type { SourceOperations } from "../src/sources.js";

const PI_URL = "https://github.com/example/demo-bundle";
const PI_IDENTITY = "git:github.com/example/demo-bundle";
const COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);
const SOURCE: GitSource = Object.freeze({ id: "git:test-source", kind: "git", url: PI_URL });
const hostSource = { kind: "external", url: PI_URL } as const;

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

type Runner = (command: string, args: readonly string[], options?: ProcessRunOptions) => Promise<ProcessRunResult>;

interface Harness {
  readonly home: string;
  readonly stateDirectory: string;
  readonly operations: PackageOperations;
  readonly calls: Call[];
  readonly hostFiles: Map<string, string>;
  setFiles(files: readonly SourceContentFile[]): void;
  setCommit(commit: string): void;
  setRunner(run: Runner): void;
  setPiPackages(entries: readonly unknown[]): void;
  setPiCheckoutEvidence(evidence: PiCheckoutEvidence): void;
  setClaudePlugins(value: unknown): void;
  setClaudeMarketplaces(value: unknown): void;
  setPortableInstallations(items: readonly ProjectSkillSelection[]): Promise<void>;
  close(): Promise<void>;
}

function okResult(): ProcessRunResult {
  return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: "", outputTooLarge: false };
}

function piFiles(version?: string): readonly SourceContentFile[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "demo-bundle",
        ...(version === undefined ? {} : { version }),
        pi: { skills: "skills" },
      }),
    },
    { path: "skills/demo/SKILL.md", content: "---\nname: demo\ndescription: demo fixture\n---\n" },
  ];
}

function claudeFiles(): readonly SourceContentFile[] {
  return [
    {
      path: ".claude-plugin/marketplace.json",
      content: JSON.stringify({ name: "demo-market", plugins: [{ name: "demo", source: "./plugins/demo" }] }),
    },
    {
      path: "plugins/demo/.claude-plugin/plugin.json",
      content: JSON.stringify({ name: "demo", version: "1.0.0" }),
    },
    { path: "plugins/demo/skills/demo/SKILL.md", content: "---\nname: demo\ndescription: demo fixture\n---\n" },
  ];
}

function piSelection(version: PackageSelection["version"] = { policy: "latest" }): PackageSelection {
  return { host: "pi", root: "", source: hostSource, version };
}

function claudeSelection(version: PackageSelection["version"] = { policy: "latest" }): PackageSelection {
  return { host: "claude", marketplaceRoot: "", pluginName: "demo", source: hostSource, version };
}

function notFound(filePath: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open ${JSON.stringify(filePath)}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

async function createHarness(options: {
  readonly files?: readonly SourceContentFile[];
  readonly commit?: string;
  readonly isWsl?: boolean;
  readonly resolveExecutable?: (name: string) => Promise<string | undefined>;
  readonly refreshProjectSource?: SourceOperations["refreshProjectSource"] | null;
  readonly readHostStateFile?: (filePath: string, hostFiles: Map<string, string>) => Promise<string>;
} = {}): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "ad-package-flow-"));
  const stateDirectory = path.join(home, "state");
  let files = [...(options.files ?? piFiles("1.0.0"))];
  let commit = options.commit ?? COMMIT;
  let run: Runner = async () => okResult();
  let piCheckoutEvidence: PiCheckoutEvidence = { issue: "fixture Pi checkout has no version evidence" };
  const calls: Call[] = [];
  const hostFiles = new Map<string, string>();

  const contentAccess: SourceContentAccess = {
    readSnapshot: async () => Object.freeze(files.map((file) => Object.freeze({ ...file }))),
    readResolvedVersion: async () => Object.freeze({ kind: "git-commit" as const, commit }),
  };
  const sourceOperations: SourceOperations = {
    addGitSource: async () => SOURCE,
    listSources: async () => Object.freeze([SOURCE]),
    refreshSource: async () => SOURCE,
    selectSources: async () => Object.freeze([SOURCE]),
    resolveProjectSource: async () => SOURCE,
    ...(options.refreshProjectSource === null
      ? {}
      : { refreshProjectSource: options.refreshProjectSource ?? (async () => SOURCE) }),
  };

  const operations = createPackageOperations({
    homeDirectory: home,
    stateDirectory,
    platform: "linux",
    isWsl: options.isWsl ?? false,
    sourceOperations,
    sourceContentAccess: contentAccess,
    ...(options.resolveExecutable === undefined
      ? { resolveExecutable: async (name: string) => `/usr/bin/${name}` }
      : { resolveExecutable: options.resolveExecutable }),
    runner: async (command, args, runOptions) => {
      calls.push({ command, args: [...args], cwd: runOptions?.cwd });
      return await run(command, args, runOptions);
    },
    readHostStateFile: async (filePath) => {
      if (options.readHostStateFile !== undefined) {
        return await options.readHostStateFile(filePath, hostFiles);
      }
      const contents = hostFiles.get(filePath);
      if (contents === undefined) {
        throw notFound(filePath);
      }
      return contents;
    },
    readPiCheckout: async () => piCheckoutEvidence,
  });

  return {
    home,
    stateDirectory,
    operations,
    calls,
    hostFiles,
    setFiles: (next) => {
      files = [...next];
    },
    setCommit: (next) => {
      commit = next;
    },
    setRunner: (next) => {
      run = next;
    },
    setPiPackages: (entries) => {
      hostFiles.set(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: entries }));
    },
    setPiCheckoutEvidence: (evidence) => {
      piCheckoutEvidence = evidence;
    },
    setClaudePlugins: (value) => {
      hostFiles.set(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(value));
    },
    setClaudeMarketplaces: (value) => {
      hostFiles.set(path.join(home, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify(value));
    },
    setPortableInstallations: async (items) => {
      await new SourceStateStore(path.join(stateDirectory, "sources.json")).save({
        version: 1,
        gitSources: [],
        userGlobalInstallations: [...items],
      });
    },
    close: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function withHarness(
  options: Parameters<typeof createHarness>[0],
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

test("discover reads the selected Source snapshot and runs no host command", async () => {
  await withHarness({}, async (harness) => {
    const descriptors = await harness.operations.discover([SOURCE.id]);
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0]!.host, "pi");
    assert.equal(descriptors[0]!.name, "demo-bundle");
    assert.equal(harness.calls.length, 0);
  });
});

test("install runs the exact host argv once through the injected runner and records the selection", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    harness.setRunner(async () => {
      harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
      return okResult();
    });
    const plan = await harness.operations.planLifecycle(selection, "install");
    assert.equal(plan.skipExecution, undefined);
    assert.deepEqual(plan.commands.map((command) => [command.executable, ...command.args]), [
      ["pi", "install", PI_IDENTITY],
    ]);
    assert.deepEqual(plan.affects, [{ host: "pi", root: "" }]);
    assert.equal(plan.origin.installId, PI_IDENTITY);
    assert.equal(plan.origin.manifestDigest.length, 64);

    await harness.operations.approve(selection, "install");
    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "installed");
    assert.deepEqual(harness.calls, [{ command: "/usr/bin/pi", args: ["install", PI_IDENTITY], cwd: harness.home }]);

    const records = await harness.operations.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.installId, PI_IDENTITY);
    assert.equal(records[0]!.lastDelegatedCommit, COMMIT);
    assert.deepEqual((await readdir(harness.stateDirectory)).sort(), ["package-approvals", "packages.json"]);
    assert.deepEqual(await readdir(harness.home), ["state"]);
  });
});

test("a manifest change between plan and execute returns stale plan and runs nothing", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    harness.setFiles(piFiles("2.0.0"));

    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "stale plan");
    assert.match(result.reason, /manifest changed/);
    assert.equal(harness.calls.length, 0);
    assert.equal((await harness.operations.list()).length, 0);
  });
});

test("a moved Source commit between plan and execute returns stale plan and runs nothing", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    harness.setCommit(NEXT_COMMIT);

    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "stale plan");
    assert.match(result.reason, /resolved Source commit changed/);
    assert.equal(harness.calls.length, 0);
  });
});

test("planning a lifecycle write fails closed when an external Source cannot be refreshed", async () => {
  await withHarness({ refreshProjectSource: null }, async (harness) => {
    await assert.rejects(
      harness.operations.planLifecycle(piSelection(), "install"),
      /requires a Source refresh/u,
    );
    assert.equal(harness.calls.length, 0);
  });
});

test("an unapproved declaration fails closed before any host command", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    const plan = await harness.operations.planLifecycle(selection, "install");
    const notConfirmed = await harness.operations.executeLifecycle(plan, false);
    assert.equal(notConfirmed.status, "not confirmed");
    await assert.rejects(harness.operations.executeLifecycle(plan, true), /not approved/);
    assert.equal(harness.calls.length, 0);
  });
});

test("a tampered plan is refused as stale before any host command", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    const tampered: PackageLifecyclePlan = {
      ...plan,
      commands: [{ ...plan.commands[0]!, args: ["install", "git:github.com/example/other"] }],
    };

    const result = await harness.operations.executeLifecycle(tampered, true);
    assert.equal(result.status, "stale plan");
    assert.match(result.reason, /Host step 1 changed/);
    assert.equal(harness.calls.length, 0);
  });
});

test("a receipt covers the exact action argv, so another action needs its own approval", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    await harness.operations.approve(selection, "install");
    assert.equal(await harness.operations.approvalStatus(selection, "install"), "approved");
    assert.equal(await harness.operations.approvalStatus(selection, "update"), "needs approval");
  });
});

test("a host state that already satisfies install sets skipExecution and runs nothing", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
    const plan = await harness.operations.planLifecycle(selection, "install");
    assert.equal(plan.skipExecution, true);
    assert.deepEqual(plan.commands.map((command) => [command.executable, ...command.args]), [
      ["pi", "install", PI_IDENTITY],
    ]);

    await harness.operations.approve(selection, "install");
    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "installed");
    assert.equal(harness.calls.length, 0);
    assert.equal((await harness.operations.list()).length, 1);
    assert.deepEqual(await readdir(harness.home), ["state"]);
  });
});

test("a fixed Pi pin does not adopt a different installed pin", async () => {
  await withHarness({ files: piFiles() }, async (harness) => {
    const selection: PackageSelection = {
      host: "pi",
      root: "",
      source: { ...hostSource, ref: COMMIT },
      version: { policy: "fixed", version: COMMIT },
    };
    harness.setPiPackages([`${PI_IDENTITY}@${NEXT_COMMIT}`]);
    harness.setPiCheckoutEvidence({ commit: NEXT_COMMIT });
    const plan = await harness.operations.planLifecycle(selection, "install");
    assert.equal(plan.skipExecution, undefined);
    assert.deepEqual(plan.commands.map((command) => [command.executable, ...command.args]), [
      ["pi", "install", `${PI_IDENTITY}@${COMMIT}`],
    ]);

    harness.setRunner(async () => {
      harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
      harness.setPiCheckoutEvidence({ commit: COMMIT });
      return okResult();
    });
    await harness.operations.approve(selection, "install");
    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "installed");
    assert.deepEqual(harness.calls, [{ command: "/usr/bin/pi", args: ["install", `${PI_IDENTITY}@${COMMIT}`], cwd: harness.home }]);
  });
});

test("a fixed Pi pin whose install leaves a different pin fails and writes no record", async () => {
  await withHarness({ files: piFiles() }, async (harness) => {
    const selection: PackageSelection = {
      host: "pi",
      root: "",
      source: { ...hostSource, ref: COMMIT },
      version: { policy: "fixed", version: COMMIT },
    };
    harness.setRunner(async () => {
      harness.setPiPackages([`${PI_IDENTITY}@${NEXT_COMMIT}`]);
      harness.setPiCheckoutEvidence({ commit: NEXT_COMMIT });
      return okResult();
    });
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "failed");
    assert.match(result.reason, /contradicts the fixed pin/u);
    assert.equal(harness.calls.length, 1);
    assert.equal((await harness.operations.list()).length, 0);
  });
});

// The live recheck is the fifth read of the Pi settings file: the shown plan, the
// approval, the fresh plan, the previous observation, then the recheck itself.
const PI_RECHECK_READ = 5;

for (const finalState of ["absent", "unknown"] as const) {
  test(`a skipped install fails if the live recheck is ${finalState}`, async () => {
    let piReads = 0;
    await withHarness({
      readHostStateFile: async (filePath, hostFiles) => {
        const piSettings = filePath.endsWith(path.join(".pi", "agent", "settings.json"));
        if (piSettings) {
          piReads += 1;
          if (piReads >= PI_RECHECK_READ) {
            if (finalState === "absent") {
              throw notFound(filePath);
            }
            // An undecodable entry degrades every lookup that section answers to unknown.
            return JSON.stringify({ packages: [{}] });
          }
        }
        const contents = hostFiles.get(filePath);
        if (contents === undefined) {
          throw notFound(filePath);
        }
        return contents;
      },
    }, async (harness) => {
      const selection = piSelection();
      harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
      const plan = await harness.operations.planLifecycle(selection, "install");
      assert.equal(plan.skipExecution, true);

      await harness.operations.approve(selection, "install");
      const result = await harness.operations.executeLifecycle(plan, true);
      assert.equal(result.status, "failed");
      assert.match(result.reason, /does not report|cannot be verified/u);
      assert.equal(harness.calls.length, 0);
      assert.equal((await harness.operations.list()).length, 0);
    });
  });
}

test("an install whose host state stays absent fails and writes no record", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "failed");
    assert.match(result.reason, /does not report/);
    assert.equal((await harness.operations.list()).length, 0);
    assert.equal(harness.calls.length, 1);
  });
});

test("an unversioned Pi git package reports unknown, never current", async () => {
  await withHarness({ files: piFiles() }, async (harness) => {
    const selection = piSelection();
    harness.setPiPackages([PI_IDENTITY]);
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    assert.equal((await harness.operations.executeLifecycle(plan, true)).status, "installed");

    const checks = await harness.operations.checkUpdates();
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.status, "unknown");
    assert.notEqual(checks[0]!.status, "current");
    assert.equal(harness.calls.length, 0);
  });
});

test("an update with unknown observed version evidence fails and leaves the record untouched", async () => {
  await withHarness({ files: piFiles() }, async (harness) => {
    const selection = piSelection();
    harness.setPiPackages([PI_IDENTITY]);
    const install = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    await harness.operations.executeLifecycle(install, true);
    const before = (await harness.operations.list())[0]!;

    const update = await harness.operations.planLifecycle(selection, "update");
    await harness.operations.approve(selection, "update");
    const result = await harness.operations.executeLifecycle(update, true);
    assert.equal(result.status, "failed");
    assert.match(result.reason, /version change cannot be verified|version.*unavailable/u);
    assert.deepEqual((await harness.operations.list())[0], before);
    assert.equal(harness.calls.length, 1);
  });
});

test("an update that installs where the host reported nothing is recorded as updated", async () => {
  await withHarness({ files: piFiles() }, async (harness) => {
    const selection = piSelection();
    harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
    const install = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    assert.equal((await harness.operations.executeLifecycle(install, true)).status, "installed");

    harness.setPiPackages([]);
    const update = await harness.operations.planLifecycle(selection, "update");
    await harness.operations.approve(selection, "update");
    harness.setRunner(async () => {
      harness.setPiPackages([`${PI_IDENTITY}@${NEXT_COMMIT}`]);
      harness.setPiCheckoutEvidence({ commit: NEXT_COMMIT });
      return okResult();
    });
    const result = await harness.operations.executeLifecycle(update, true);
    assert.equal(result.status, "updated");
    assert.deepEqual(result.previous, { kind: "absent" });
    assert.deepEqual((await harness.operations.list())[0]!.verified, { kind: "git-commit", commit: NEXT_COMMIT });
  });
});

test("records persist the observed host version evidence", async () => {
  await withHarness({ files: piFiles() }, async (harness) => {
    const selection = piSelection();
    harness.setRunner(async () => {
      harness.setPiPackages([`${PI_IDENTITY}@${NEXT_COMMIT}`]);
      harness.setPiCheckoutEvidence({ commit: NEXT_COMMIT });
      return okResult();
    });

    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "installed");
    assert.deepEqual((await harness.operations.list())[0]!.verified, { kind: "git-commit", commit: NEXT_COMMIT });
  });
});

test("an unverifiable host observation writes no verified evidence", async () => {
  await withHarness({ files: piFiles() }, async (harness) => {
    const selection = piSelection();
    harness.setRunner(async () => {
      harness.setPiPackages([PI_IDENTITY]);
      return okResult();
    });
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    assert.equal((await harness.operations.executeLifecycle(plan, true)).status, "installed");
    assert.equal((await harness.operations.list())[0]!.verified, undefined);
  });
});

test("an update whose observed version is unchanged fails and leaves the record untouched", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
    harness.setPiCheckoutEvidence({ commit: COMMIT });
    const install = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    await harness.operations.executeLifecycle(install, true);
    const before = (await harness.operations.list())[0]!;

    const update = await harness.operations.planLifecycle(selection, "update");
    assert.deepEqual(update.commands.map((command) => [command.executable, ...command.args]), [
      ["pi", "update", PI_IDENTITY],
    ]);
    await harness.operations.approve(selection, "update");
    const result = await harness.operations.executeLifecycle(update, true);
    assert.equal(result.status, "failed");
    assert.match(result.reason, /did not change/);
    assert.deepEqual((await harness.operations.list())[0], before);
    assert.equal(harness.calls.length, 1);
  });
});

test("one broken Package in a batch does not hide the other checks", async () => {
  await withHarness({ files: [...piFiles(), ...claudeFiles()] }, async (harness) => {
    const pi = piSelection();
    const claude = claudeSelection();
    harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
    harness.setPiCheckoutEvidence({ commit: COMMIT });
    harness.setClaudePlugins({
      plugins: { "demo@demo-market": [{ scope: "user", installPath: "/cache/demo", version: "1.0.0" }] },
    });
    harness.setClaudeMarketplaces({
      "demo-market": { source: { source: "github", repo: "example/demo-bundle" }, installLocation: "/market" },
    });
    for (const selection of [pi, claude]) {
      const plan = await harness.operations.planLifecycle(selection, "install");
      assert.equal(plan.skipExecution, true);
      await harness.operations.approve(selection, "install");
      assert.equal((await harness.operations.executeLifecycle(plan, true)).status, "installed");
    }
    assert.equal(harness.calls.length, 0);

    harness.setFiles(piFiles());
    const checks = await harness.operations.checkUpdates();
    assert.equal(checks.length, 2);
    const claudeCheck = checks.find((check) => check.installed.selection.host === "claude")!;
    const piCheck = checks.find((check) => check.installed.selection.host === "pi")!;
    assert.equal(claudeCheck.status, "unknown");
    assert.equal(piCheck.status, "current");
  });
});

test("a Claude install registers the marketplace then applies, and skips a known marketplace", async () => {
  await withHarness({ files: claudeFiles() }, async (harness) => {
    const selection = claudeSelection();
    const first = await harness.operations.planLifecycle(selection, "install");
    assert.deepEqual(first.commands.map((command) => [command.purpose, command.executable, ...command.args]), [
      ["register", "claude", "plugin", "marketplace", "add", PI_URL],
      ["apply", "claude", "plugin", "install", "demo@demo-market"],
    ]);
    assert.equal(first.origin.installId, "demo@demo-market");

    harness.setClaudeMarketplaces({
      "demo-market": { source: { source: "github", repo: "example/demo-bundle" }, installLocation: "/market" },
    });
    const second = await harness.operations.planLifecycle(selection, "install");
    assert.deepEqual(second.commands.map((command) => [command.purpose, command.executable, ...command.args]), [
      ["apply", "claude", "plugin", "install", "demo@demo-market"],
    ]);
  });
});

test("a fixed-version Claude selection fails closed instead of ignoring the pin", async () => {
  await withHarness({ files: claudeFiles() }, async (harness) => {
    await assert.rejects(
      harness.operations.planLifecycle(claudeSelection({ policy: "fixed", version: "1.0.0" }), "install"),
      /cannot carry the pin/,
    );
    assert.equal(harness.calls.length, 0);
  });
});

test("a blocked WSL Windows executable falls back to manual required", async () => {
  await withHarness({ isWsl: true, resolveExecutable: async () => "/mnt/c/pi.exe" }, async (harness) => {
    const selection = piSelection();
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    const result = await harness.operations.executeLifecycle(plan, true);
    assert.equal(result.status, "manual required");
    assert.match(result.reason, /Windows executable on WSL/);
    assert.equal(harness.calls.length, 0);
  });
});

test("forget requires confirmation, drops the record, and runs no host command", async () => {
  await withHarness({}, async (harness) => {
    const selection = piSelection();
    harness.setPiPackages([`${PI_IDENTITY}@${COMMIT}`]);
    const plan = await harness.operations.planLifecycle(selection, "install");
    await harness.operations.approve(selection, "install");
    await harness.operations.executeLifecycle(plan, true);
    assert.equal((await harness.operations.list()).length, 1);

    await assert.rejects(harness.operations.forget(selection, false), /explicit confirmation/);
    await harness.operations.forget(selection, true);
    assert.equal((await harness.operations.list()).length, 0);
    assert.equal(harness.calls.length, 0);
  });
});

test("no package module reaches the Skill install engine", async () => {
  const directory = path.resolve("src");
  const moduleNames = (await readdir(directory))
    .filter((name) => name.startsWith("package-") && name.endsWith(".ts"))
    .sort();
  assert.ok(moduleNames.length >= 5);
  const engine = [
    "skill-install.js",
    "project-installation.js",
    "skill-removal.js",
    "skill-update.js",
    "unmanaged-removal.js",
    "skill-adoption.js",
    "user-global-skill-inventory.js",
    "update-flow.js",
    "update-batch.js",
  ];
  for (const moduleName of moduleNames) {
    const source = await readFile(path.join(directory, moduleName), "utf8");
    for (const specifier of source.match(/from "[^"]+"/gu) ?? []) {
      for (const forbidden of engine) {
        assert.ok(!specifier.endsWith(`/${forbidden}"`), `${moduleName} imports ${forbidden}`);
      }
    }
  }
});

test("install and select refuse a Package that would duplicate a managed portable Skill", async () => {
  await withHarness({}, async (harness) => {
    await harness.setPortableInstallations([{
      source: hostSource,
      path: "skills/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/demo", adopted: false },
    }]);

    await assert.rejects(
      harness.operations.planLifecycle(piSelection(), "install"),
      /would duplicate a Skill already managed as portable installations \("skills\/demo"\); forget those installations first\. No path was changed\./,
    );
    await assert.rejects(harness.operations.planLifecycle(piSelection(), "select"), /would duplicate a Skill/);
    assert.equal(harness.calls.length, 0);
  });
});

test("install plans normally when the portable installations belong to another Source", async () => {
  await withHarness({}, async (harness) => {
    await harness.setPortableInstallations([{
      source: { kind: "external", url: "https://github.com/other/repo" },
      path: "skills/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/demo", adopted: false },
    }]);

    const plan = await harness.operations.planLifecycle(piSelection(), "install");
    assert.equal(plan.action, "install");
    assert.equal(harness.calls.length, 0);
  });
});
