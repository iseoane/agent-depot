import assert from "node:assert/strict";
import { test } from "node:test";

import { discoverBundlesInSnapshot, parseClaudeMarketplace, parsePiPackageManifest } from "../src/package-bundles.js";
import {
  affectedBy,
  assertValidHostArgv,
  classifyUpdate,
  hostInstallId,
  HOST_STEP_TEMPLATES,
  packageApprovalDigest,
  PackagePlanError,
  planHostSteps,
} from "../src/package-host-plans.js";
import type { HostInstallView, HostStateSection } from "../src/package-host-state.js";
import type { BundleDescriptor, PackageDeclaration, PackageSelection } from "../src/package-model.js";

const PI_URL = "https://github.com/michael-denyer/pstack-claude";

function piDescriptor(): BundleDescriptor {
  return parsePiPackageManifest(
    JSON.stringify({ name: "pstack-claude", pi: { skills: ["./plugins/pstack/skills"] } }),
    "",
  );
}

function claudeDescriptor(pluginName = "pstack"): BundleDescriptor {
  const marketplaceRaw = JSON.stringify({
    name: "pstack-claude",
    owner: { name: "Example" },
    plugins: [{ name: pluginName, source: "./plugins/pstack" }],
  });
  const pluginRaw = JSON.stringify({ name: pluginName });
  return parseClaudeMarketplace(marketplaceRaw, "", (root) => root === "plugins/pstack" ? pluginRaw : undefined)[0];
}

function piSelection(url = PI_URL, version: PackageSelection["version"] = { policy: "latest" }): PackageSelection {
  return { host: "pi", root: "", source: { kind: "external", url, ref: "main" }, version };
}

function claudeSelection(pluginName = "pstack"): PackageSelection {
  return {
    host: "claude",
    marketplaceRoot: "",
    pluginName,
    source: { kind: "external", url: PI_URL, ref: "main" },
    version: { policy: "latest" },
  };
}

function section<T>(id: HostStateSection<T>["id"], records: readonly T[]): HostStateSection<T> {
  return { id, path: `/home/${id}.json`, present: true, records };
}

function emptyView(): HostInstallView {
  return {
    pi: section("pi-settings", []),
    claudePlugins: section("claude-installed-plugins", []),
    claudeMarketplaces: section("claude-known-marketplaces", []),
  };
}

function knownMarketplaceView(name = "pstack-claude", repo = "michael-denyer/pstack-claude"): HostInstallView {
  return {
    ...emptyView(),
    claudeMarketplaces: section("claude-known-marketplaces", [
      { name, source: { kind: "github", repo }, installLocation: `/marketplaces/${name}` },
    ]),
  };
}

function installedPluginView(pluginName = "pstack", marketplace = "pstack-claude", version = "0.9.69"): HostInstallView {
  return {
    ...emptyView(),
    claudePlugins: section("claude-installed-plugins", [
      {
        installId: `${pluginName}@${marketplace}`,
        pluginName,
        marketplace,
        scope: "user",
        installPath: `/cache/${marketplace}/${pluginName}/${version}`,
        version,
        drifted: false,
      },
    ]),
  };
}

test("every host exposes a template for every action", () => {
  for (const host of ["pi", "claude"] as const) {
    for (const action of ["install", "update", "uninstall", "select", "forget"] as const) {
      assert.equal(typeof HOST_STEP_TEMPLATES[host][action], "function");
    }
  }
});

test("Pi argv is scoped, and only install carries the fixed-version pin", () => {
  assert.deepEqual(planHostSteps("install", piDescriptor(), piSelection(), emptyView()), [
    ["pi", "install", "git:github.com/michael-denyer/pstack-claude"],
  ]);
  assert.deepEqual(planHostSteps("update", piDescriptor(), piSelection(), emptyView()), [
    ["pi", "update", "git:github.com/michael-denyer/pstack-claude"],
  ]);
  assert.deepEqual(planHostSteps("uninstall", piDescriptor(), piSelection(), emptyView()), [
    ["pi", "remove", "git:github.com/michael-denyer/pstack-claude"],
  ]);
  assert.deepEqual(planHostSteps("select", piDescriptor(), piSelection(), emptyView()), []);
  assert.deepEqual(planHostSteps("forget", piDescriptor(), piSelection(), emptyView()), []);

  const pinned = piSelection(PI_URL, { policy: "fixed", version: "v1.2.3" });
  assert.deepEqual(planHostSteps("install", piDescriptor(), pinned, emptyView()), [
    ["pi", "install", "git:github.com/michael-denyer/pstack-claude@v1.2.3"],
  ]);
  assert.deepEqual(planHostSteps("update", piDescriptor(), pinned, emptyView()), [
    ["pi", "update", "git:github.com/michael-denyer/pstack-claude"],
  ]);
});

test("Claude install adds an unknown marketplace, then installs the plugin at the named marketplace", () => {
  assert.deepEqual(
    planHostSteps("install", claudeDescriptor(), claudeSelection(), emptyView(), { marketplaceName: "pstack-claude" }),
    [
      ["claude", "plugin", "marketplace", "add", PI_URL],
      ["claude", "plugin", "install", "pstack@pstack-claude"],
    ],
  );
});

test("a known marketplace omits only the add step", () => {
  assert.deepEqual(
    planHostSteps("install", claudeDescriptor(), claudeSelection(), knownMarketplaceView()),
    [["claude", "plugin", "install", "pstack@pstack-claude"]],
  );
});

test("Claude update always names the marketplace it refreshes", () => {
  assert.deepEqual(
    planHostSteps("update", claudeDescriptor(), claudeSelection(), knownMarketplaceView()),
    [
      ["claude", "plugin", "marketplace", "update", "pstack-claude"],
      ["claude", "plugin", "update", "pstack@pstack-claude"],
    ],
  );
  assert.deepEqual(
    planHostSteps("update", claudeDescriptor(), claudeSelection(), installedPluginView()),
    [
      ["claude", "plugin", "marketplace", "update", "pstack-claude"],
      ["claude", "plugin", "update", "pstack@pstack-claude"],
    ],
  );
});

test("Claude uninstall names the plugin and its marketplace, and select runs nothing", () => {
  assert.deepEqual(
    planHostSteps("uninstall", claudeDescriptor(), claudeSelection(), knownMarketplaceView()),
    [["claude", "plugin", "uninstall", "pstack@pstack-claude"]],
  );
  assert.deepEqual(planHostSteps("select", claudeDescriptor(), claudeSelection(), knownMarketplaceView()), []);
  assert.deepEqual(planHostSteps("forget", claudeDescriptor(), claudeSelection(), knownMarketplaceView()), []);
});

test("a Claude plan that must name an unresolved marketplace fails closed", () => {
  assert.throws(
    () => planHostSteps("install", claudeDescriptor(), claudeSelection(), emptyView()),
    PackagePlanError,
  );
  assert.throws(
    () => planHostSteps("update", claudeDescriptor(), claudeSelection(), emptyView()),
    PackagePlanError,
  );
});

test("a Claude descriptor with no in-repo marketplace binding is refused", () => {
  const unbound = parseClaudeMarketplace(
    JSON.stringify({ name: "m", owner: { name: "Example" }, plugins: [{ name: "p", source: { command: "echo hi" } }] }),
    "",
    () => undefined,
  )[0];
  assert.throws(
    () => planHostSteps("install", unbound, claudeSelection("p"), emptyView(), { marketplaceName: "m" }),
    PackagePlanError,
  );
  assert.deepEqual(planHostSteps("select", unbound, claudeSelection("p"), emptyView()), []);
});

test("a Pi package from a scoped Source is refused", () => {
  const scoped = discoverBundlesInSnapshot(
    [{ path: "plugins/pstack/package.json", content: JSON.stringify({ name: "pstack", pi: { skills: ["./skills"] } }) }],
    { directory: "plugins/pstack" },
  )[0];
  assert.ok(scoped.warnings.some((warning) => warning.includes("register the repository root")));
  assert.throws(() => planHostSteps("install", scoped, piSelection(), emptyView()), PackagePlanError);
});

test("a descriptor and selection that disagree on the host are refused", () => {
  assert.throws(
    () => planHostSteps("install", claudeDescriptor(), piSelection(), emptyView()),
    PackagePlanError,
  );
});

test("a built-in or local path Source has no host-facing command", () => {
  assert.throws(
    () => planHostSteps("install", piDescriptor(), {
      host: "pi",
      root: "",
      source: { kind: "builtin", id: "builtin:agent-depot" },
      version: { policy: "latest" },
    }, emptyView()),
    PackagePlanError,
  );
  assert.throws(
    () => planHostSteps("install", claudeDescriptor(), {
      host: "claude",
      marketplaceRoot: "",
      pluginName: "pstack",
      source: { kind: "external", path: "./local" },
      version: { policy: "latest" },
    }, emptyView(), { marketplaceName: "m" }),
    PackagePlanError,
  );
});

test("shell syntax, control characters, and blocked executables are refused", () => {
  assert.throws(
    () => planHostSteps("install", piDescriptor(), piSelection("https://github.com/owner/repo;rm"), emptyView()),
    PackagePlanError,
  );
  assert.throws(
    () => planHostSteps("install", claudeDescriptor("p;rm"), claudeSelection("p;rm"), emptyView(), { marketplaceName: "m" }),
    PackagePlanError,
  );
  assert.throws(
    () => planHostSteps("install", claudeDescriptor(), claudeSelection(), emptyView(), { marketplaceName: "mkt\n" }),
    PackagePlanError,
  );
  assert.throws(() => assertValidHostArgv(["pi.cmd", "install", "x"], "test"), PackagePlanError);
  assert.throws(() => assertValidHostArgv(["pi", "install", "$(rm)"], "test"), PackagePlanError);
});

test("V1 scoped verbs make every action affect only the selection's coordinates", () => {
  const selection = piSelection();
  const otherPi: PackageSelection = {
    host: "pi",
    root: "nested",
    source: { kind: "external", url: "https://github.com/owner/other", ref: "main" },
    version: { policy: "latest" },
  };
  const otherClaude = claudeSelection("other");
  assert.deepEqual(affectedBy("update", selection, [selection, otherPi, otherClaude]), [{ host: "pi", root: "" }]);
  assert.deepEqual(affectedBy("install", selection, [selection, otherPi]), [{ host: "pi", root: "" }]);
  assert.deepEqual(
    affectedBy("uninstall", otherClaude, [selection, otherClaude]),
    [{ host: "claude", marketplaceRoot: "", pluginName: "other" }],
  );
});

test("the approval digest is canonical over the declaration and its exact argv order", () => {
  const declaration: PackageDeclaration = {
    sourceUrl: PI_URL,
    ref: "main",
    coordinates: { host: "pi", root: "" },
    manifestDigest: "a".repeat(64),
    argv: [["pi", "install", "git:github.com/michael-denyer/pstack-claude"]],
  };
  const digest = packageApprovalDigest(declaration);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(digest, packageApprovalDigest({ ...declaration }));
  assert.equal(digest, packageApprovalDigest({
    argv: declaration.argv,
    manifestDigest: declaration.manifestDigest,
    coordinates: declaration.coordinates,
    sourceUrl: declaration.sourceUrl,
    ref: declaration.ref,
  }));
  assert.notEqual(
    digest,
    packageApprovalDigest({ ...declaration, argv: [["pi", "install", "git:github.com/michael-denyer/other"]] }),
  );
  assert.notEqual(digest, packageApprovalDigest({ ...declaration, ref: "release" }));
  assert.notEqual(
    packageApprovalDigest({ ...declaration, argv: [["pi", "install", "a"], ["pi", "install", "b"]] }),
    packageApprovalDigest({ ...declaration, argv: [["pi", "install", "b"], ["pi", "install", "a"]] }),
  );
});

test("classifyUpdate compares like evidence and reports a mixed pair unknown", () => {
  const bundle = { kind: "manifest-version", declaredBy: "bundle" } as const;
  assert.equal(classifyUpdate({ kind: "installed", version: "1.0.0" }, { ...bundle, version: "1.0.1" }), "update available");
  assert.equal(classifyUpdate({ kind: "installed", version: "v1.0.1" }, { ...bundle, version: "1.0.1" }), "current");
  assert.equal(classifyUpdate({ kind: "installed", version: "2.0.0" }, { ...bundle, version: "1.0.0" }), "current");
  assert.equal(classifyUpdate({ kind: "installed", version: "abc" }, { ...bundle, version: "1.0.0" }), "unknown");
  assert.equal(classifyUpdate({ kind: "installed", version: "abc" }, { ...bundle, version: "abc" }), "current");

  assert.equal(classifyUpdate({ kind: "installed", commit: "ABC" }, { kind: "git-commit", commit: "abc" }), "current");
  assert.equal(classifyUpdate({ kind: "installed", commit: "abc" }, { kind: "git-commit", commit: "def" }), "update available");

  assert.equal(classifyUpdate({ kind: "installed", version: "1.0.0" }, { kind: "git-commit", commit: "abc" }), "unknown");
  assert.equal(classifyUpdate({ kind: "installed", commit: "abc" }, { ...bundle, version: "1.0.0" }), "unknown");
  assert.equal(classifyUpdate({ kind: "installed" }, { ...bundle, version: "1.0.0" }), "unknown");
  assert.equal(classifyUpdate({ kind: "absent" }, { ...bundle, version: "1.0.0" }), "unknown");
  assert.equal(classifyUpdate({ kind: "unknown", reason: "drifted" }, { ...bundle, version: "1.0.0" }), "unknown");
  assert.equal(classifyUpdate({ kind: "installed", version: "1.0.0" }, undefined), "unknown");
});

test("a fixed-version Claude selection is refused instead of silently ignoring the pin", () => {
  const pinned: PackageSelection = { ...claudeSelection(), version: { policy: "fixed", version: "1.0.0" } };
  for (const action of ["install", "update"] as const) {
    assert.throws(
      () => planHostSteps(action, claudeDescriptor(), pinned, knownMarketplaceView()),
      (error: unknown) => error instanceof PackagePlanError && /cannot carry the pin/.test(error.message),
    );
  }
  assert.deepEqual(planHostSteps("uninstall", claudeDescriptor(), pinned, knownMarketplaceView()), [
    ["claude", "plugin", "uninstall", "pstack@pstack-claude"],
  ]);
});

test("the install identity is the host's own token for the selection", () => {
  assert.equal(hostInstallId(claudeDescriptor(), claudeSelection(), knownMarketplaceView()), "pstack@pstack-claude");
  assert.equal(hostInstallId(piDescriptor(), piSelection(), emptyView()), "git:github.com/michael-denyer/pstack-claude");
});
