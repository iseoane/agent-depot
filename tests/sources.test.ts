import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BUILT_IN_SOURCE,
  BuiltInSourceError,
  createSourceOperations,
  parseSourceInstallationMethod,
  SourceMetadataError,
  SourceNotFoundError,
  SourceSelectionError,
} from "../src/sources.js";
import { defaultSourceStatePath, SourceStateError, SourceStateStore } from "../src/source-state.js";
import type { GitSource, GitSourceAccess } from "../src/git-source.js";
import type { SourceContentAccess } from "../src/skill-discovery.js";

class FakeGitAccess implements GitSourceAccess {
  readonly refreshed: GitSource[] = [];

  async refresh(source: GitSource): Promise<void> {
    this.refreshed.push(source);
  }
}

async function withState<T>(run: (statePath: string, gitAccess: FakeGitAccess) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-sources-"));
  try {
    return await run(path.join(directory, "sources.json"), new FakeGitAccess());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("lists the package-owned built-in Source without registering it", async () => {
  await withState(async (statePath, gitAccess) => {
    const operations = createSourceOperations({ statePath, gitAccess });

    assert.deepEqual(await operations.listSources(), [BUILT_IN_SOURCE]);
    assert.equal(await readFile(statePath).catch(() => undefined), undefined);
  });
});

test("adds a Git Source, keeps its URL identity stable, and does not refresh on registration", async () => {
  await withState(async (statePath, gitAccess) => {
    const operations = createSourceOperations({ statePath, gitAccess });

    const first = await operations.addGitSource("https://github.com/example/skills/");
    const duplicate = await operations.addGitSource("https://github.com/example/skills");

    assert.equal(first.id, duplicate.id);
    assert.equal(first.url, "https://github.com/example/skills");
    assert.deepEqual(gitAccess.refreshed, []);
    assert.deepEqual(await operations.listSources(), [BUILT_IN_SOURCE, first]);
  });
});

test("rejects non-Git and unsafe URLs before changing state", async () => {
  await withState(async (statePath, gitAccess) => {
    const operations = createSourceOperations({ statePath, gitAccess });
    const invalidUrls = [
      "ftp://example.com/skills.git",
      "https://example.com/skills with spaces.git",
      "https://user:secret@example.com/skills.git",
      "https://host//",
      "https://example.com/",
      "not a URL",
    ];

    for (const url of invalidUrls) {
      await assert.rejects(operations.addGitSource(url));
    }
    assert.deepEqual(await operations.listSources(), [BUILT_IN_SOURCE]);
    assert.deepEqual(gitAccess.refreshed, []);
  });
});

test("refreshes a registered Source through the injected Git access at its registered URL", async () => {
  await withState(async (statePath, gitAccess) => {
    const operations = createSourceOperations({ statePath, gitAccess });
    const source = await operations.addGitSource("ssh://git@github.com/example/skills.git");

    const refreshed = await operations.refreshSource(source.id);

    assert.equal(refreshed.url, source.url);
    assert.deepEqual(gitAccess.refreshed, [source]);
    await assert.rejects(operations.refreshSource(BUILT_IN_SOURCE.id), BuiltInSourceError);
    await assert.rejects(operations.refreshSource("git:missing"), SourceNotFoundError);
  });
});

test("serializes concurrent registrations without losing catalog updates", async () => {
  await withState(async (statePath, gitAccess) => {
    const urls = Array.from({ length: 12 }, (_, index) => `https://github.com/example/parallel-${index}.git`);
    const operations = urls.map(() => createSourceOperations({ statePath, gitAccess }));

    await Promise.all(urls.map((url, index) => operations[index].addGitSource(url)));

    const sources = await operations[0].listSources();
    assert.equal(sources.length, urls.length + 1);
    assert.deepEqual(
      new Set(sources.slice(1).map((source) => {
        if (source.kind !== "git") {
          throw new Error("expected only Git Sources after the built-in Source");
        }
        return source.url;
      })),
      new Set(urls),
    );
  });
});

test("keeps the old identity when a new URL is added", async () => {
  await withState(async (statePath, gitAccess) => {
    const operations = createSourceOperations({ statePath, gitAccess });
    const original = await operations.addGitSource("https://github.com/example/old-skills.git");
    const replacement = await operations.addGitSource("https://github.com/example/new-skills.git");

    assert.notEqual(original.id, replacement.id);
    assert.deepEqual(await operations.listSources(), [BUILT_IN_SOURCE, original, replacement]);
  });
});

test("selects Sources only for the current operation and never saves a default", async () => {
  await withState(async (statePath, gitAccess) => {
    const operations = createSourceOperations({ statePath, gitAccess });
    const external = await operations.addGitSource("https://github.com/example/skills.git");
    const before = await readFile(statePath, "utf8");

    assert.deepEqual(await operations.selectSources([BUILT_IN_SOURCE.id, external.id]), [BUILT_IN_SOURCE, external]);
    assert.deepEqual(await operations.selectSources([external.id, external.id]), [external]);
    assert.equal(await readFile(statePath, "utf8"), before);
    await assert.rejects(operations.selectSources([]), SourceSelectionError);
    await assert.rejects(operations.selectSources(["git:missing"]), SourceNotFoundError);
    assert.deepEqual(gitAccess.refreshed, []);
  });
});

test("fails closed on corrupt or unsupported state and preserves bytes when adding", async () => {
  await withState(async (statePath, gitAccess) => {
    const malformedCatalog = JSON.stringify({
      version: 1,
      gitSources: [
        { id: "git:existing", kind: "git", url: "https://github.com/example/existing.git" },
        { id: "git:broken", kind: "git", url: "not a URL" },
      ],
    });
    const unsupportedState = JSON.stringify({ version: 2, gitSources: [] });

    for (const contents of ["{not valid JSON", unsupportedState, malformedCatalog]) {
      await writeFile(statePath, contents, "utf8");
      const operations = createSourceOperations({ statePath, gitAccess });
      const before = await readFile(statePath, "utf8");

      await assert.rejects(operations.listSources(), SourceStateError);
      await assert.rejects(
        operations.addGitSource("https://github.com/example/recovered.git"),
        (error: unknown) => error instanceof SourceStateError && error.message.includes(statePath),
      );
      assert.equal(await readFile(statePath, "utf8"), before);
    }
  });
});

test("discovers only explicitly selected Source snapshots without refreshing or persisting selection", async () => {
  await withState(async (statePath, gitAccess) => {
    const externalUrl = "https://github.com/example/skills.git";
    let selectedExternal: GitSource | undefined;
    const contentAccess: SourceContentAccess = {
      async readSnapshot(source) {
        assert.equal(source.id, selectedExternal?.id);
        return [{
          path: "chosen/SKILL.md",
          content: "---\nname: Chosen\ndescription: Chosen skill\n---\n",
        }];
      },
    };
    const operations = createSourceOperations({ statePath, gitAccess, sourceContentAccess: contentAccess });
    selectedExternal = await operations.addGitSource(externalUrl);
    const before = await readFile(statePath, "utf8");

    assert.deepEqual(await operations.discoverSkills([selectedExternal.id]), [{
      sourceId: selectedExternal.id,
      path: "chosen",
      name: "Chosen",
      description: "Chosen skill",
    }]);
    assert.equal(await readFile(statePath, "utf8"), before);
    assert.deepEqual(gitAccess.refreshed, []);
    await assert.rejects(operations.discoverSkills([]), SourceSelectionError);
  });
});

test("loads legacy Source state and persists user-global installations in the shared catalog", async () => {
  await withState(async (statePath, gitAccess) => {
    await writeFile(statePath, JSON.stringify({ version: 1, gitSources: [] }), "utf8");
    const operations = createSourceOperations({ statePath, gitAccess });

    assert.ok(operations.listUserGlobalInstallations);
    assert.ok(operations.addUserGlobalInstallation);
    assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
    await operations.addUserGlobalInstallation!({
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/demo", adopted: false },
      methods: {
        install: { kind: "command", argv: ["pnpm", "dlx", "demo-skill"] },
        update: { kind: "command", argv: ["npm", "exec", "--", "demo-skill", "update"] },
      },
    });

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      gitSources: unknown[];
      userGlobalInstallations: unknown[];
    };
    assert.deepEqual(state.gitSources, []);
    assert.equal(state.userGlobalInstallations.length, 1);
    assert.deepEqual((state.userGlobalInstallations[0] as { methods: unknown }).methods, {
      install: { kind: "command", argv: ["pnpm", "dlx", "demo-skill"] },
      update: { kind: "command", argv: ["npm", "exec", "--", "demo-skill", "update"] },
    });
    assert.equal((await operations.listUserGlobalInstallations!())[0]?.methods?.install?.argv[0], "pnpm");
  });
});

test("validates source methods with the same portable no-shell safety rules", () => {
  assert.deepEqual(parseSourceInstallationMethod({
    kind: "command",
    argv: ["pnpm", "dlx", "demo-skill"],
    cwd: "tools",
  }), {
    kind: "command",
    argv: ["pnpm", "dlx", "demo-skill"],
    cwd: "tools",
  });

  for (const method of [
    { kind: "command", argv: ["bash", "-c", "echo unsafe"] },
    { kind: "command", argv: ["dash", "-c", "echo unsafe"] },
    { kind: "command", argv: ["ksh", "-c", "echo unsafe"] },
    { kind: "command", argv: ["pnpm", "--api-key=secret"] },
    { kind: "command", argv: ["pnpm", "REGISTRY_TOKEN=secret"] },
    { kind: "command", argv: ["pnpm", "https://user:secret@example.com/skill"] },
    { kind: "command", argv: ["pnpm", "install"], cwd: "tools/TOKEN=secret" },
    { kind: "command", argv: ["pnpm", "install"], cwd: "C:/tools" },
    { kind: "command", argv: ["pnpm", "install"], windows: ["pnpm.cmd"] },
  ]) {
    assert.throws(() => parseSourceInstallationMethod(method), SourceMetadataError);
  }
});

test("rejects persisted user-global installations without an installation location", async () => {
  await withState(async (statePath, gitAccess) => {
    const contents = JSON.stringify({
      version: 1,
      gitSources: [],
      userGlobalInstallations: [{
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: "portable/demo",
        version: { policy: "latest" },
        hosts: ["pi"],
      }],
    });
    await writeFile(statePath, contents, "utf8");
    const operations = createSourceOperations({ statePath, gitAccess });

    await assert.rejects(
      operations.listUserGlobalInstallations!(),
      (error: unknown) => error instanceof SourceStateError && error.message.includes("installation location"),
    );
    assert.equal(await readFile(statePath, "utf8"), contents);
  });
});

test("rejects adding a user-global installation without an installation location", async () => {
  await withState(async (statePath, gitAccess) => {
    const operations = createSourceOperations({ statePath, gitAccess });

    await assert.rejects(
      operations.addUserGlobalInstallation!({
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: "portable/demo",
        version: { policy: "latest" },
        hosts: ["pi"],
      }),
      (error: unknown) => error instanceof SourceSelectionError && error.message.includes("installation location"),
    );
    assert.equal(await readFile(statePath).catch(() => undefined), undefined);
  });
});

test("uses portable per-user state locations on Linux and Windows", () => {
  assert.equal(
    defaultSourceStatePath({ XDG_STATE_HOME: "/state" }, "linux", "/home/alice"),
    "/state/agent-depot/sources.json",
  );
  assert.equal(
    defaultSourceStatePath({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32", "C:\\Users\\alice"),
    "C:\\Users\\alice\\AppData\\Roaming\\Agent Depot\\sources.json",
  );
  assert.equal(new SourceStateStore("/tmp/agent-depot-test-state").path, "/tmp/agent-depot-test-state");
});
