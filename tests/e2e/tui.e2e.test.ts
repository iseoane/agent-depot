import assert from "node:assert/strict";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { profileSandbox, seedProfileSandbox } from "../profile-e2e-fixture.js";

import { fakeAppFixture } from "../fake-app-fixture.js";

import pty from "@homebridge/node-pty-prebuilt-multiarch";
import { sourceIdForUrl } from "../../src/git-source.js";

// Compiled location: dist/tests/e2e -> the built CLI is dist/src/cli.js.
const CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
// Terminal escape sequences are control characters by definition.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;
const TIMEOUT_MS = 30_000;

let sandbox: string;
let homeDirectory: string;
let projectRoot: string;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "agent-depot-e2e-"));
  homeDirectory = path.join(sandbox, "home");
  projectRoot = path.join(sandbox, "project");
  await mkdir(homeDirectory);
  await mkdir(projectRoot);
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** Drives the built CLI inside a real pseudo-terminal with an isolated HOME and cwd. */
class TuiSession {
  private readonly terminal: pty.IPty;
  private output = "";
  private readonly exited: Promise<number>;
  private exit: { exitCode: number; signal?: number } | undefined;
  private rawLength = 0;

  constructor(environment: NodeJS.ProcessEnv = {}, cols = 110, rows = 40) {
    // Ink renders only the final frame when it detects CI (`CI` / `CONTINUOUS_INTEGRATION`), which leaves an
    // interactive PTY blank. The session is a real terminal, so hide the CI markers from the child.
    const inherited = { ...process.env };
    delete inherited.CI;
    delete inherited.CONTINUOUS_INTEGRATION;
    this.terminal = pty.spawn(process.execPath, [CLI, "tui"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: projectRoot,
      env: {
        ...inherited, TERM: "xterm-256color", HOME: homeDirectory, USERPROFILE: homeDirectory,
        XDG_STATE_HOME: path.join(homeDirectory, ".local", "state"),
        XDG_CONFIG_HOME: path.join(homeDirectory, ".config"),
        XDG_CACHE_HOME: path.join(homeDirectory, ".cache"),
        NO_COLOR: "1", FORCE_COLOR: "0", ...environment,
      },
    });
    this.terminal.onData((data) => {
      this.output += data;
      this.rawLength += data.length;
    });
    this.exited = new Promise((resolve) =>
      this.terminal.onExit(({ exitCode, signal }) => {
        this.exit = { exitCode, signal };
        resolve(exitCode);
      }),
    );
  }

  /** Text rendered since the last `send` (or since spawn), ANSI stripped. */
  get screen(): string {
    return this.output.replace(ANSI, "");
  }

  /** Clears the capture buffer, sends keys, and waits for the expected output to appear. */
  async send(keys: string, expected: RegExp): Promise<string> {
    this.output = "";
    this.terminal.write(keys);
    return this.waitFor(expected);
  }

  /** Sends keys without waiting for output (used for the final quit). */
  press(keys: string): void {
    this.terminal.write(keys);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** Child state for failure messages: exit code/signal and total raw chars received since spawn. */
  private get diagnostics(): string {
    const state = this.exit ? `exited code=${this.exit.exitCode} signal=${this.exit.signal ?? 0}` : "still running";
    return `child ${state}; ${this.rawLength} raw chars received`;
  }

  async waitFor(expected: RegExp): Promise<string> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const screen = this.screen;
      assert.doesNotMatch(screen, /Error:|TypeError/u, `TUI reported an error:\n${screen}`);
      if (expected.test(screen)) return screen;
      if (this.exit) {
        assert.fail(`TUI exited early while waiting for ${String(expected)}; ${this.diagnostics}; screen:\n${screen}`);
      }
      if (Date.now() >= deadline) {
        assert.fail(`Timed out waiting for ${String(expected)}; ${this.diagnostics}; screen:\n${screen}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async exitCode(): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TUI did not exit; ${this.diagnostics}; screen:\n${this.screen}`)), TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  kill(): void {
    try {
      this.terminal.kill();
    } catch {
      // Already exited.
    }
  }
}

test("the TUI walks every view in a real terminal and quits cleanly", { timeout: 120_000 }, async () => {
  const session = new TuiSession();
  try {
    await session.waitFor(/Agent Depot[\s\S]*n add ·/u);

    const catalog = await session.send("2", /▸ builtin:agent-depot \(3\)/u);
    assert.match(catalog, /Scope: all sources/u);
    await session.send("\r", /doctor-md-skill/u);

    const installations = await session.send("3", /Managed \(user-global\) \(0\)/u);
    assert.match(installations, /Unmanaged \(user-global\)/u);

    const updates = await session.send("4", /no Git sources to refresh/u);
    assert.match(updates, /Updates \(scope: all\)/u);

    const profile = await session.send("5", /e export · i import/u);
    assert.match(profile, /5 Import\/Export/u);

    const sources = await session.send("1", /builtin:agent-depot/u);
    assert.match(sources, /n add ·/u);

    // `n` opens the add-Source prompt (keys are captured), Esc cancels back to the list.
    await session.send("n", /Enter submit · Esc cancel/u);
    await session.send("\u001b", /n add ·/u);

    // `/` opens the Catalog filter and narrows the list.
    await session.send("2", /▸ builtin:agent-depot \(3\)/u);
    await session.send("/", /Enter submit · Esc cancel/u);
    const filtered = await session.send("agents", /doctor-md-agents/u);
    // Ink repaints whole frames, each starting with the header: judge the last one only.
    assert.doesNotMatch(filtered.split("Agent Depot").pop() ?? "", /doctor-md-skill/u);
    await session.send("\u001b", /j\/k move/u);

    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally {
    session.kill();
  }
});

test("active Pi and Claude Package owners stay readable in a narrow real terminal", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-catalog-owners-"));
  const home = path.join(root, "home");
  const repository = path.join(root, "pstack");
  const url = "https://example.test/packages/pstack.git";
  const piOwnerName = "agent-depot-package-owner-name-that-is-deliberately-long-to-force-wrapping";
  const claudeOwnerName = "claude-plugin-owner-name-that-is-deliberately-long-to-force-wrapping";
  const gitConfig = path.join(root, "gitconfig");
  await mkdir(home);
  await cp(path.resolve("tests", "fixtures", "packages", "pstack"), repository, { recursive: true });
  await writeFile(path.join(repository, "package.json"), `${JSON.stringify({
    name: piOwnerName,
    version: "0.9.69",
    keywords: ["pi-package", "pstack", "poteto-mode"],
    pi: { skills: ["./plugins/pi/skills"], extensions: ["./plugins/pstack/pi/index.ts"] },
    peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
  }, null, 2)}\n`);
  const marketplacePath = path.join(repository, ".claude-plugin", "marketplace.json");
  await writeFile(marketplacePath, `${JSON.stringify({
    name: "pstack-claude",
    owner: { name: "Fixture" },
    plugins: [{ name: claudeOwnerName, source: "./plugins/pstack", version: "0.9.69" }],
  }, null, 2)}\n`);
  await writeFile(path.join(repository, "plugins", "pstack", ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: claudeOwnerName, version: "0.9.69", agents: [] }, null, 2)}\n`);
  const piSkillDirectory = path.join(repository, "plugins", "pi", "skills", "pty-pi-owner");
  await mkdir(piSkillDirectory, { recursive: true });
  await writeFile(path.join(piSkillDirectory, "SKILL.md"), "---\nname: pty-pi-owner\ndescription: PTY fixture for Pi ownership\n---\n");
  await writeFile(gitConfig, `[url "file://${repository}"]\n\tinsteadOf = ${url}\n[protocol "file"]\n\tallow = always\n[user]\n\tname = e2e\n\temail = e2e@example.test\n`);
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "fixture"]]) {
    execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  execFileSync(process.execPath, [CLI, "source", "add", url], { cwd: projectRoot, env, stdio: "pipe" });
  execFileSync(process.execPath, [CLI, "source", "refresh", sourceIdForUrl(url), "--yes"], { cwd: projectRoot, env, stdio: "pipe" });
  const stateDirectory = path.join(env.XDG_STATE_HOME, "agent-depot");
  await mkdir(stateDirectory, { recursive: true });
  const source = { kind: "external", url };
  await writeFile(path.join(stateDirectory, "packages.json"), `${JSON.stringify({
    version: 1,
    packages: [
      { selection: { host: "pi", root: "", source, version: { policy: "latest" } }, installId: "fixture-pi", verifiedAt: "2026-01-01T00:00:00.000Z" },
      { selection: { host: "claude", marketplaceRoot: "", pluginName: claudeOwnerName, source, version: { policy: "latest" } }, installId: "fixture-claude", verifiedAt: "2026-01-01T00:00:00.000Z" },
    ],
  }, null, 2)}\n`);

  const session = new TuiSession(env, 40, 17);
  try {
    await session.waitFor(/n add ·/u);
    await session.send("2", /example.test\/packages\/pstack \(3\)/u);
    await session.send("j", /> ▸ example.test\/packages\/pstack/u);
    await session.send("\r", /▾ example.test\/packages\/pstack/u);
    await session.send("j", />\s+▸ Packages \(2\)/u);
    await session.send("\r", /Package agent-depot-package/u);
    const pi = await session.send("jjj", /Package-owned Skill: provided by the pi[\s\S]*?force-wrapping/u);
    const piFrame = pi.split("Agent Depot").at(-1) ?? pi;
    assert.ok(piFrame.split("\n").length <= 17, `40-column PTY frame exceeded 17 rows:\n${piFrame}`);
    assert.match(pi, /\d+–\d+ of \d+/u);
    assert.match(pi, /j\/k move/u);
    session.resize(80, 24);
    const claude = await session.send("j", /Package-owned Skill: provided by the claude[\s\S]*?force-wrapping/u);
    assert.match(claude, /j\/k move/u);
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally {
    session.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-interactive run exits 1 with a clean message", { timeout: 60_000 }, async () => {
  const child = spawnProcess(process.execPath, [CLI, "tui"], {
    cwd: projectRoot,
    env: { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr.trim(), "Error: agent-depot tui requires an interactive terminal");
});

test("the TUI approves and installs an App, then offers its update", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fakeAppFixture(sandbox);
  const session = new TuiSession({
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    XDG_STATE_HOME: path.join(sandbox, "state"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
  });
  try {
    await session.waitFor(/n add ·/u);
    await session.send("3", /Apps \(user-global\) \(1\)/u);
    await assert.rejects(readFile(fixture.log), { code: "ENOENT" });
    // Empty Managed/global, Managed/project and Unmanaged roots precede Apps.
    await session.send("jjj", /> ▸ Apps \(user-global\)/u);
    await session.send("\r", /fixture-app/u);
    await session.send("j", /> .*fixture-app/u);
    await session.send("\r", /Approve fixture-app\? y\/n/u);
    await session.send("y", /Approved fixture-app/u);
    await session.send("i", /install fixture-app\? y\/n/u);
    await session.send("y", /fixture-app: installed/u);
    assert.equal(await readFile(fixture.state, "utf8"), "1.0.0");
    const updates = await session.send("4", /App: fixture-app/u);
    assert.match(updates, /1\.0\.0/);
    assert.match(updates, /2\.0\.0/);
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally { session.kill(); }
});


test("the Profile tab exports choices and imports them into a fresh HOME", { timeout: 120_000, skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-profile-tui-"));
  const sessions: TuiSession[] = [];
  try {
    const repo = path.join(root, "repo");
    const a = await profileSandbox(path.join(root, "a"), repo);
    const b = await profileSandbox(path.join(root, "b"), repo);
    await seedProfileSandbox(a, repo);
    const file = path.join(root, "profile.json");
    const exporting = new TuiSession(a.env);
    sessions.push(exporting);
    await exporting.waitFor(/n add ·/u);
    await exporting.send("5", /e export · i import/u);
    const checklist = await exporting.send("e", /Enter preview/u);
    assert.match(checklist, /Sources: https:\/\/example.test\/profile\/source.git/u);
    assert.match(checklist, /Skills: skills\/alpha/u);
    assert.match(checklist, /Apps: fixture-app \(windows\)/u);
    await exporting.send("\r", /Profile path:/u);
    await exporting.send(file, /profile.json/u);
    await exporting.send("\r", /Apply Profile\? \(y\/n\)/u);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    await exporting.send("y", /Exported profile to/u);
    const profile = JSON.parse(await readFile(file, "utf8"));
    assert.equal(profile.skills.length, 2);
    exporting.press("q");
    assert.equal(await exporting.exitCode(), 0);

    const importing = new TuiSession(b.env);
    sessions.push(importing);
    await importing.waitFor(/n add ·/u);
    await importing.send("5", /e export · i import/u);
    await importing.send("i", /Profile path:/u);
    await importing.send(file, /profile.json/u);
    const plan = await importing.send("\r", /Enter preview/u);
    assert.match(plan, /add: Source/u);
    assert.match(plan, /add: Skill skills\/alpha/u);
    assert.match(plan, /App recipe fixture-app \(windows/u);
    await importing.send("\r", /Apply Profile\? \(y\/n\)/u);
    await assert.rejects(readFile(path.join(b.home, ".agents/skills/alpha/SKILL.md")), { code: "ENOENT" });
    await importing.send("y", /added: App recipe fixture-app \(windows/u);
    importing.press("q");
    assert.equal(await importing.exitCode(), 0);
    assert.deepEqual(JSON.parse(b.cli("export").stdout), profile);
    assert.match(b.ok("app", "list"), /needs approval/u);
  } finally {
    for (const session of sessions) session.kill();
    await rm(root, { recursive: true, force: true });
  }
});
