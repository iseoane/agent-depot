import assert from "node:assert/strict";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { profileSandbox, seedProfileSandbox } from "../profile-e2e-fixture.js";

import { fakeAppFixture } from "../fake-app-fixture.js";

import pty from "@homebridge/node-pty-prebuilt-multiarch";
import { createAppOperations } from "../../src/app-flow.js";
import { sourceIdForUrl } from "../../src/git-source.js";

// Compiled location: dist/tests/e2e -> the built CLI is dist/src/cli.js.
const CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
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
  private columns: number;
  private rows: number;
  private cursorX = 0;
  private cursorY = 0;
  private cells: string[][];

  constructor(environment: NodeJS.ProcessEnv = {}, cols = 110, rows = 40) {
    this.columns = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => []);
    // Ink renders only the final frame when it detects CI (`CI` / `CONTINUOUS_INTEGRATION`), which leaves an
    // interactive PTY blank. The session is a real terminal, so hide the CI markers from the child.
    const inherited: NodeJS.ProcessEnv = {
      ...process.env, TERM: "xterm-256color", HOME: homeDirectory, USERPROFILE: homeDirectory,
      XDG_STATE_HOME: path.join(homeDirectory, ".local", "state"),
      XDG_CONFIG_HOME: path.join(homeDirectory, ".config"),
      XDG_CACHE_HOME: path.join(homeDirectory, ".cache"),
      NO_COLOR: "1", FORCE_COLOR: "0", ...environment,
    };
    delete inherited.CI;
    delete inherited.CONTINUOUS_INTEGRATION;
    this.terminal = pty.spawn(process.execPath, [CLI, "tui"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: projectRoot,
      env: inherited,
    });
    this.terminal.onData((data) => {
      this.output += data;
      this.rawLength += data.length;
      this.updateScreen(data);
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
    return this.cells.map(line => line.join("").replace(/\s+$/u, "")).join("\n");
  }

  get terminalOutput(): string {
    return this.output;
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
    this.columns = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, (_, index) => this.cells[index]?.slice(0, cols) ?? []);
    this.cursorX = Math.min(this.cursorX, cols - 1);
    this.cursorY = Math.min(this.cursorY, rows - 1);
    this.terminal.resize(cols, rows);
  }

  private updateScreen(chunk: string): void {
    const clearLine = (mode: number) => {
      const start = mode === 0 ? this.cursorX : 0;
      const end = mode === 1 ? this.cursorX + 1 : this.columns;
      for (let column = start; column < end; column += 1) this.cells[this.cursorY]![column] = " ";
    };
    const lineFeed = () => {
      this.cursorY += 1;
      if (this.cursorY >= this.rows) {
        this.cells.shift();
        this.cells.push([]);
        this.cursorY = this.rows - 1;
      }
    };
    for (let index = 0; index < chunk.length;) {
      if (chunk[index] === "\u001b") {
        if (chunk[index + 1] === "[") {
          let end = index + 2;
          while (end < chunk.length && (chunk.charCodeAt(end) < 0x40 || chunk.charCodeAt(end) > 0x7e)) end += 1;
          if (end >= chunk.length) break;
          const final = chunk[end]!;
          const raw = chunk.slice(index + 2, end);
          const params = raw.replace(/^\?/u, "").split(";").map(value => Number(value) || 0);
          const amount = params[0] || 1;
          if (final === "H" || final === "f") {
            this.cursorY = Math.min(Math.max((params[0] || 1) - 1, 0), this.rows - 1);
            this.cursorX = Math.min(Math.max((params[1] || 1) - 1, 0), this.columns - 1);
          } else if (final === "A") this.cursorY = Math.max(this.cursorY - amount, 0);
          else if (final === "B") this.cursorY = Math.min(this.cursorY + amount, this.rows - 1);
          else if (final === "C") this.cursorX = Math.min(this.cursorX + amount, this.columns - 1);
          else if (final === "D") this.cursorX = Math.max(this.cursorX - amount, 0);
          else if (final === "G") this.cursorX = Math.min(Math.max(amount - 1, 0), this.columns - 1);
          else if (final === "d") this.cursorY = Math.min(Math.max(amount - 1, 0), this.rows - 1);
          else if (final === "K") clearLine(params[0] ?? 0);
          else if (final === "J" && (params[0] === 2 || params[0] === 3)) {
            this.cells = Array.from({ length: this.rows }, () => []);
            this.cursorX = 0;
            this.cursorY = 0;
          }
          index = end + 1;
          continue;
        }
        if (chunk[index + 1] === "]") {
          const bell = chunk.indexOf("\u0007", index + 2);
          const terminator = chunk.indexOf("\u001b\\", index + 2);
          const end = bell < 0 ? terminator : terminator < 0 ? bell : Math.min(bell, terminator);
          index = end < 0 ? chunk.length : end + (chunk[end] === "\u0007" ? 1 : 2);
          continue;
        }
        index += 2;
        continue;
      }
      const character = String.fromCodePoint(chunk.codePointAt(index)!);
      index += character.length;
      if (character === "\r") this.cursorX = 0;
      else if (character === "\n") lineFeed();
      else if (character === "\b") this.cursorX = Math.max(this.cursorX - 1, 0);
      else if (character === "\t") this.cursorX = Math.min(Math.floor(this.cursorX / 8 + 1) * 8, this.columns - 1);
      else if (character >= " ") {
        if (this.cursorX >= this.columns) {
          this.cursorX = 0;
          lineFeed();
        }
        this.cells[this.cursorY]![this.cursorX] = character;
        const codePoint = character.codePointAt(0)!;
        const wide = codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint >= 0x2e80);
        this.cursorX += wide ? 2 : 1;
      }
    }
  }

  /** Child state for failure messages: exit code/signal and total raw chars received since spawn. */
  private get diagnostics(): string {
    const state = this.exit ? `exited code=${this.exit.exitCode} signal=${this.exit.signal ?? 0}` : "still running";
    return `child ${state}; ${this.rawLength} raw chars received`;
  }

  async waitFor(expected: RegExp, ready: (screen: string) => boolean = () => true): Promise<string> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const screen = this.output.replace(ANSI, "");
      assert.doesNotMatch(screen, /Error:|TypeError/u, `TUI reported an error:\n${screen}`);
      if (expected.test(screen) && ready(screen)) return this.screen;
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

function capturedOutput(session: TuiSession): string {
  return session.terminalOutput.replace(ANSI, "").replaceAll("\r", "");
}

async function scrollPreviewToEnd(session: TuiSession, ready: RegExp): Promise<string> {
  let visited = capturedOutput(session);
  for (let move = 0; move < 200; move += 1) {
    if (ready.test(session.screen)) return visited + capturedOutput(session);
    await session.send("\u001b[6~", new RegExp(`${ready.source}|j\\/k · PgUp\\/PgDn`, ready.flags));
    visited += capturedOutput(session);
  }
  assert.fail(`preview did not reach confirmation:\n${session.screen}`);
}

test("the TUI walks every view in a real terminal and quits cleanly", { timeout: 120_000 }, async () => {
  const session = new TuiSession();
  try {
    await session.waitFor(/AGENT DEPOT[\s\S]*n add ·/u);
    assert.ok(session.terminalOutput.includes("\u001B[?1049h"), "the TUI starts in Ink's alternate screen");
    const initialFrame = session.screen.slice(session.screen.lastIndexOf("╭"));
    assert.ok(initialFrame.split("\n").length >= 40, `startup did not fill the 40-row PTY:\n${initialFrame}`);

    const catalog = await session.send("2", /▸ builtin:agent-depot \(3\)/u);
    assert.match(catalog, /Scope: all sources/u);
    assert.match(catalog, /a repo/u);
    await session.send("a", /3 selected/u);
    const marked = await session.send("\r", /doctor-md-skill/u);
    assert.match(marked, /\[x\] doctor-md-skill/u);
    const cleared = await session.send("a", /Scope: all sources/u);
    assert.doesNotMatch(cleared, /\d+ selected/u);

    const installations = await session.send("3", /Managed \(user-global\) \(0\)/u);
    assert.match(installations, /Unmanaged \(user-global\)/u);

    const updates = await session.send("4", /no Git sources to refresh/u);
    assert.match(updates, /Updates \(scope: all\)/u);

    const profile = await session.send("5", /e export · i import/u);
    assert.match(profile, /Portable user-global Profile/u);
    assert.match(profile, /▶ \[5\] Profile/u);

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
    assert.doesNotMatch(filtered.split("AGENT DEPOT").pop() ?? "", /doctor-md-skill/u);
    await session.send("\u001b", /j\/k move/u);

    session.press("q");
    assert.equal(await session.exitCode(), 0);
    assert.ok(session.terminalOutput.includes("\u001B[?1049l"), "Ink restores the primary screen when the TUI exits");
  } finally {
    session.kill();
  }
});

test("the Catalog keeps numbered destinations and Packages readable in a narrow real terminal", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
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
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=e2e", "-c", "user.email=e2e@example.test", "commit", "-qm", "fixture"]]) {
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
    const narrowHeader = await session.waitFor(/n add ·/u);
    assert.match(narrowHeader, /AGENT DEPOT/u, `40-column header lost its title:\n${narrowHeader}`);
    assert.match(narrowHeader, /v0\.5\.2/u, `40-column header lost the package version:\n${narrowHeader}`);
    for (const destination of ["[1] Sources", "[2] Catalog", "[3] Installations", "[4] Updates", "[5] Profile"]) {
      assert.ok(narrowHeader.includes(destination), `40-column header lost ${destination}:\n${narrowHeader}`);
    }
    await session.send("2", /example.test\/packages\/pstack \(3\)/u);
    await session.send("/", /Enter submit · Esc cancel/u);
    const narrowCatalog = await session.send("pstack", /Package agent-depot-package/u);
    assert.ok(narrowCatalog.split("\n").length <= 17, `40-column PTY frame exceeded 17 rows:\n${narrowCatalog}`);
    session.resize(80, 24);
    const resized = await session.waitFor(/Package agent-depot-package/u, screen => screen.split("\n").length >= 24);
    assert.match(resized, /AGENT DEPOT/u);
    assert.match(resized, /v0\.5\.2/u);
    for (const destination of ["[1] Sources", "[2] Catalog", "[3] Installations", "[4] Updates", "[5] Profile"]) {
      assert.ok(resized.includes(destination), `resized header lost ${destination}:\n${resized}`);
    }
    assert.ok(resized.split("\n").length >= 24, `resize did not fill the 24-row PTY:\n${resized}`);
    await session.send("\r", /j\/k move/u);
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

test("narrow recipe approval keeps all execution terms reachable before consent", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const fixtureRoot = path.join(sandbox, "preview-terms");
  const fixture = await fakeAppFixture(fixtureRoot);
  const home = path.join(fixtureRoot, "approval-home");
  const state = path.join(fixtureRoot, "approval-state");
  const recipes = path.join(state, "agent-depot", "apps");
  await mkdir(recipes, { recursive: true });
  const approvalRecipe = {
    ...fixture.recipe,
    name: `aaa-review-all-terms-${"long-approved-recipe-name-".repeat(2)}`,
    install: { argv: ["depot-e2e-app", "install", "separate", "argv", "--danger=host-setup-tail"], manual: "Install manually without dropping this full instruction" },
    update: { manual: "Manual update instruction must remain completely reviewable, including its final words" },
    latest: { argv: ["depot-e2e-app", "latest", "latest-selector-unchanged"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    setup: { pi: { argv: ["depot-e2e-app", "setup", "pi", "host-setup-tail"] } },
    teardown: { pi: { manual: `${"Host teardown instruction ".repeat(12)}FINAL-DANGER-TERM-MUST-STAY-HIDDEN` } },
  };
  const recipeFile = path.join(recipes, "review-all-terms.json");
  await writeFile(recipeFile, JSON.stringify(approvalRecipe));
  await Promise.all(Array.from({ length: 30 }, (_, index) => writeFile(
    path.join(recipes, `secondary-${String(index).padStart(2, "0")}.json`),
    JSON.stringify({ ...fixture.recipe, name: `zzz-secondary-${String(index).padStart(2, "0")}` }),
  )));
  const session = new TuiSession({
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: path.join(fixtureRoot, "approval-config"),
    XDG_CACHE_HOME: path.join(fixtureRoot, "approval-cache"),
  }, 80, 24);
  try {
    await session.waitFor(/n add ·/u);
    await session.send("j", /review-all-terms[\s\S]*needs approval/u);
    const approvalQuestion = () => {
      const visible = session.screen.replace(/\s/gu, "");
      return visible.includes("Approve") && visible.includes("y/n");
    };
    let preview = await session.send("\r", /Scroll to end before y/u);
    assert.match(preview, /File:/u);
    assert.doesNotMatch(preview, /latest-selector-unchanged|Host teardown instruction/u);
    assert.ok(preview.split("\n").length <= 24, `wide preview exceeded the 24-row PTY:\n${preview}`);
    for (let move = 0; move < 80 && !approvalQuestion(); move += 1) {
      session.press("\u001b[6~");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(approvalQuestion(), `wide preview never exposed its approval question:\n${session.screen}`);
    assert.ok(session.screen.replace(/\s/gu, "").includes(approvalRecipe.name), `wide preview truncated the approved recipe name:\n${session.screen}`);
    assert.doesNotMatch(session.screen, /zzz-secondary/u, `wide preview left the Sources list visible below the panel:\n${session.screen}`);
    assert.match(session.screen, /FINAL-DANGER-TERM-MUST-STAY-HIDDEN/u, `wide preview never exposed its final term:\n${session.screen}`);
    assert.ok(session.screen.split("\n").length <= 24, `wide final preview exceeded the 24-row PTY:\n${session.screen}`);
    preview += session.screen;
    while (/Review (\d+) of (\d+)/u.test(session.screen) && Number(/Review (\d+) of (\d+)/u.exec(session.screen)?.[1]) > 1) {
      session.press("\u001b[5~");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    session.resize(40, 17);
    await session.send("j", /Review 2 of \d+/u);
    const count = Number(/Review 2 of (\d+)/u.exec(session.screen)?.[1]);
    assert.ok(count > 14, `test recipe should exceed the 40x17 viewport: ${count}`);
    for (let move = 0; move < 120 && !approvalQuestion(); move += 1) {
      const current = /Review (\d+) of (\d+)/u.exec(session.screen);
      assert.ok(current, `preview lost its physical-row position:\n${session.screen}`);
      if (current[1] === current[2]) break;
      preview += await session.send("j", new RegExp(`Review (?!${current[1]} of)\\d+ of`));
    }
    const nearEnd = /Review (\d+) of (\d+)/u.exec(session.screen);
    assert.ok(nearEnd, `preview lost its position before consent:\n${session.screen}`);
    assert.ok(approvalQuestion(), `did not reach the final approval boundary:\n${session.screen}`);
    const beforeFinal = Number(nearEnd[1]) - 1;
    session.press("k");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(session.screen, /Scroll to end before y/u, `previous preview row did not close confirmation:\n${session.screen}`);
    assert.equal(Number(/Review (\d+) of (\d+)/u.exec(session.screen)?.[1]), beforeFinal, `preview cursor did not move back one physical row:\n${session.screen}`);
    session.press("y");
    await new Promise(resolve => setTimeout(resolve, 50));
    const prematureConfirm = session.screen;
    assert.match(prematureConfirm, /Scroll to end before y/u, `y approved while the final preview content was not displayed:\n${prematureConfirm}`);
    assert.doesNotMatch(prematureConfirm, /latest-selector-unchanged|FINAL-DANGER-TERM-MUST-STAY-HIDDEN/u);
    assert.ok(prematureConfirm.split("\n").length <= 17, `resized preview exceeded the 17-row PTY:\n${prematureConfirm}`);
    await assert.rejects(readdir(path.join(state, "agent-depot", "app-approvals")), { code: "ENOENT" });
    for (let move = 0; move < 80 && !approvalQuestion(); move += 1) {
      session.press("\u001b[6~");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(approvalQuestion(), `complete preview did not restore the approval question:\n${session.screen}`);
    assert.ok(session.screen.split("\n").length <= 17, `final preview exceeded the 17-row PTY:\n${session.screen}`);
    preview += session.screen;
    const reviewed = preview.split("\n").map(line => line.replace(/^.*?│/u, "").replace(/│.*$/u, "").trim()).join(" ");
    const continuous = reviewed.replace(/\s/gu, "");
    const argv = ["depot-e2e-app", "install", "separate", "argv", "--danger=host-setup-tail"];
    let position = continuous.indexOf("argv:[");
    for (const argument of argv) {
      position = continuous.indexOf(JSON.stringify(argument), position + 1);
      assert.notEqual(position, -1, `approval omitted or reordered argv value ${JSON.stringify(argument)}:\n${reviewed}`);
    }
    assert.ok(continuous.includes("latest-selector-unchanged"));
    assert.ok(continuous.includes("setup"));
    assert.ok(continuous.includes("FINAL-DANGER-TERM-MUST-STAY-HIDDEN"));
    assert.ok(continuous.includes("Installmanually"));
    assert.ok(continuous.includes("fullinstruction"));
    assert.ok(continuous.includes(home.replace(/\s/gu, "")), `full approval cwd was not reachable:\n${reviewed}`);
    assert.ok(continuous.includes(fixture.bin.replace(/\s/gu, "")), `full executable path was not reachable:\n${reviewed}`);
    assert.ok(continuous.includes("Environment:linux".replace(/\s/gu, "")));
    await assert.rejects(readFile(fixture.log), { code: "ENOENT" });
    await session.send("y", /review-all-terms[\s\S]*approved/u);
  } finally {
    session.kill();
  }
});

test("the narrow TUI keeps recipe approval separate from confirmed App installation and updates", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fakeAppFixture(sandbox);
  const previewHome = homeDirectory;
  await writeFile(fixture.file, JSON.stringify({
    ...fixture.recipe,
    install: { ...fixture.recipe.install, manual: `${"Manual install terms remain reviewable. ".repeat(30)}FINAL-INSTALL-MANUAL-TERM` },
  }));
  const apps = createAppOperations({
    homeDirectory: previewHome,
    recipesDirectory: path.join(sandbox, "state", "agent-depot", "apps"),
  });
  const [entry] = await apps.load();
  assert.ok(entry, "fixture recipe exists before approval");
  await apps.approve(entry);
  const session = new TuiSession({
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    HOME: previewHome,
    USERPROFILE: previewHome,
    XDG_STATE_HOME: path.join(sandbox, "state"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
  }, 80, 24);
  try {
    await session.waitFor(/n add ·/u);
    await session.send("\t", /▶ \[2\] Catalog/u);
    await session.send("/", /Enter submit · Esc cancel/u);
    await session.send("fixture-app", /Filter: fixture-app/u);
    await session.send("\r", /j\/k move/u);
    await session.send("j", />\s+App fixture-app\s+not installed/u);
    await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
    await session.send("i", /Scroll to end before y/u);
    let installPreview = capturedOutput(session);
    session.resize(40, 17);
    await session.send("j", /Review 2 of \d+/u);
    installPreview += capturedOutput(session);
    const installRows = Number(/Review 2 of (\d+)/u.exec(session.screen)?.[1]);
    assert.ok(installRows > 11, `long install preview should exceed the resized 40x17 viewport: ${installRows}\n${session.screen}`);
    for (let move = 0; move < 80; move += 1) {
      const progress = /Review (\d+) of (\d+)/u.exec(session.screen);
      assert.ok(progress, `resized install preview lost its row position:\n${session.screen}`);
      if (Number(progress[1]) - 1 + 10 >= Number(progress[2])) break;
      await session.send("\u001b[6~", /j\/k · PgUp\/PgDn/u);
      installPreview += capturedOutput(session);
    }
    const beforeInstall = session.screen;
    const nearEnd = /Review (\d+) of (\d+)/u.exec(beforeInstall);
    assert.ok(nearEnd && Number(nearEnd[1]) - 1 + 10 >= Number(nearEnd[2]), `did not reach the old wide-viewport consent boundary:\n${beforeInstall}`);
    await session.send("k", new RegExp(`Review ${Number(nearEnd[1]) - 1} of ${nearEnd[2]}`));
    await session.send("j", new RegExp(`Review ${nearEnd[1]} of ${nearEnd[2]}`));
    session.press("y");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(session.screen, /Scroll to end before y/u, `y executed before the complete install preview was displayed:\n${session.screen}`);
    assert.ok(session.screen.split("\n").length <= 17, `resized install preview exceeded the 17-row PTY:\n${session.screen}`);
    assert.ok(!(await readFile(fixture.log, "utf8")).split("\n").some(line => line.includes('"install"')), "early y must not execute the install command");
    await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
    const beforeFinalPage = /Review (\d+) of (\d+)/u.exec(session.screen);
    assert.ok(beforeFinalPage, `resized preview lost its position before the final term:\n${session.screen}`);
    const nextCursor = Math.min(Number(beforeFinalPage[1]) - 1 + 4, Number(beforeFinalPage[2]) - 1);
    await session.send("\u001b[6~", new RegExp(`Review ${nextCursor + 1} of ${beforeFinalPage[2]}`));
    const visibleManual = session.screen.replace(/[│╭╮╰╯]/gu, "").replace(/\s/gu, "");
    assert.ok(visibleManual.includes("FINAL-INSTALL-MANUAL-TERM"), `complete manual term was not rendered while scrolling:\n${session.screen}`);
    installPreview += capturedOutput(session);
    installPreview += await scrollPreviewToEnd(session, /install fixture-app\? y\/n/u);
    const continuousInstallPreview = installPreview.replace(/\s/gu, "");
    assert.ok(continuousInstallPreview.includes("argv:["), `install preview omitted JSON argv:\n${installPreview}`);
    assert.ok(continuousInstallPreview.includes("Executable:"));
    assert.ok(continuousInstallPreview.includes("depot-e2e-app"));
    assert.ok(!continuousInstallPreview.includes("Executable:…"), `install preview abbreviated the executable path:\n${installPreview}`);
    assert.ok(continuousInstallPreview.includes("Environment:linux"));
    const finalInstallPreview = session.screen.replace(/[│╭╮╰╯]/gu, "").replace(/\s/gu, "");
    assert.ok(finalInstallPreview.includes(previewHome.replace(/\s/gu, "")), `install preview omitted the full working directory:\n${session.screen}`);
    assert.ok(session.screen.split("\n").length <= 17, `confirmation exceeded the 17-row PTY:\n${session.screen}`);
    assert.ok(!(await readFile(fixture.log, "utf8")).split("\n").some(line => line.includes('"install"')), "preview must not execute the recipe");
    const installed = await session.send("y", /fixture-app: installed/u);
    assert.ok(installed.split("\n").length <= 17, `result exceeded the 17-row PTY:\n${installed}`);
    assert.match(installed, /Result · complete/u);
    for (const destination of ["[1] Sources", "[2] Catalog", "[3] Installations", "[4] Updates", "[5] Profile"]) {
      assert.ok(installed.includes(destination), `install result lost ${destination}:\n${installed}`);
    }
    assert.equal(await readFile(fixture.state, "utf8"), "1.0.0");
    const appRecords = await readdir(path.join(fixture.stateDirectory, "app-installations"));
    assert.equal(appRecords.length, 1, `successful install did not write the App installation record: ${appRecords.join(", ")}`);

    await session.send("3", />\s+Managed \(user-global\)/u);
    await session.send("j", />\s+Managed \(project\)/u);
    await session.send("j", />\s+Unmanaged \(user-global\)/u);
    await session.send("j", />\s+▸ Apps \(user-global\) \(1\)/u);
    await session.send("\r", />\s+▾ Apps \(user-global\) \(1\)/u);
    await session.send("j", />\s+\[ \]\s+fixture-app\s+1\.0\.0/u);
    session.resize(80, 24);
    await session.waitFor(/j\/k move/u, screen => screen.split("\n").length >= 24);
    const uninstallPreview = await session.send("u", /uninstall fixture-app\? y\/n/u);
    const continuousUninstallPreview = uninstallPreview.replace(/\s/gu, "");
    assert.ok(continuousUninstallPreview.includes("Executable:"));
    assert.ok(continuousUninstallPreview.includes("depot-e2e-app"));
    assert.ok(continuousUninstallPreview.includes("Environment:linux"));
    assert.ok(continuousUninstallPreview.includes(homeDirectory.replace(/\s/gu, "")), `80x24 preview omitted the complete working directory:\n${uninstallPreview}`);
    assert.ok(!(await readFile(fixture.log, "utf8")).split("\n").some(line => line.includes('"uninstall"')), "preview must not run uninstall");
    await session.send("n", /fixture-app: cancelled/u);
    const updates = await session.send("4", /App: fixture-app/u);
    assert.match(updates, /1\.0\.0/u);
    assert.match(updates, /2\.0\.0/u);
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
