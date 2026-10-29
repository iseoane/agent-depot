import assert from "node:assert/strict";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { profileSandbox, seedProfileSandbox } from "../profile-e2e-fixture.js";

import { fakeAppFixture } from "../fake-app-fixture.js";

import pty from "@homebridge/node-pty-prebuilt-multiarch";
import { createAppOperations } from "../../src/app-flow.js";
import { AGENT_DEPOT_PACKAGE_VERSION } from "../../src/project-manifest.js";
import { sourceIdForUrl } from "../../src/git-source.js";
import { createSourceOperations } from "../../src/sources.js";

// Compiled location: dist/tests/e2e -> the built CLI is dist/src/cli.js.
const CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;
const TIMEOUT_MS = 30_000;

function ansiColor(red: number, green: number, blue: number, text: string): string {
  return `\u001b[38;2;${red};${green};${blue}m${text}`;
}

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
  private completedCells: string[][] = [];
  private completedFrameCount = 0;
  private synchronizedUpdateOpen = false;
  private pendingOutput = "";

  /** `args` is the CLI command line; the default opens the TUI. */
  constructor(environment: NodeJS.ProcessEnv = {}, cols = 110, rows = 40, args: readonly string[] = ["tui"]) {
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
      PI_CODING_AGENT_DIR: path.join(homeDirectory, ".pi", "agent"),
      NO_COLOR: "1", FORCE_COLOR: "0", ...environment,
    };
    delete inherited.CI;
    delete inherited.CONTINUOUS_INTEGRATION;
    if (environment.FORCE_COLOR === "3") {
      delete inherited.NO_COLOR;
      // FORCE_COLOR=3 still resolves to 256-color for TERM=xterm-256color without this hint.
      inherited.COLORTERM = "truecolor";
    }
    this.terminal = pty.spawn(process.execPath, [CLI, ...args], {
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

  /** The last complete synchronized terminal frame, ANSI stripped. */
  get screen(): string {
    const cells = this.completedFrameCount ? this.completedCells : this.cells;
    return cells.map(line => line.join("").replace(/\s+$/u, "")).join("\n");
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
    const resizeCells = (cells: string[][]) => Array.from({ length: rows }, (_, index) => cells[index]?.slice(0, cols) ?? []);
    this.cells = resizeCells(this.cells);
    this.completedCells = resizeCells(this.completedCells);
    this.cursorX = Math.min(this.cursorX, cols - 1);
    this.cursorY = Math.min(this.cursorY, rows - 1);
    this.terminal.resize(cols, rows);
  }

  private updateScreen(chunk: string): void {
    const input = this.pendingOutput + chunk;
    this.pendingOutput = "";
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
    for (let index = 0; index < input.length;) {
      if (input[index] === "\u001b") {
        if (index + 1 >= input.length) {
          this.pendingOutput = input.slice(index);
          break;
        }
        if (input[index + 1] === "[") {
          let end = index + 2;
          while (end < input.length && (input.charCodeAt(end) < 0x40 || input.charCodeAt(end) > 0x7e)) end += 1;
          if (end >= input.length) {
            this.pendingOutput = input.slice(index);
            break;
          }
          const final = input[end]!;
          const raw = input.slice(index + 2, end);
          if (raw === "?2026" && final === "h") this.synchronizedUpdateOpen = true;
          else if (raw === "?2026" && final === "l" && this.synchronizedUpdateOpen) {
            this.completedCells = this.cells.map(line => line.slice());
            this.completedFrameCount += 1;
            this.synchronizedUpdateOpen = false;
          }
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
        if (input[index + 1] === "]") {
          const bell = input.indexOf("\u0007", index + 2);
          const terminator = input.indexOf("\u001b\\", index + 2);
          const end = bell < 0 ? terminator : terminator < 0 ? bell : Math.min(bell, terminator);
          if (end < 0) {
            this.pendingOutput = input.slice(index);
            break;
          }
          index = end + (input[end] === "\u0007" ? 1 : 2);
          continue;
        }
        index += 2;
        continue;
      }
      const character = String.fromCodePoint(input.codePointAt(index)!);
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
    const completedFrameCountBeforeWait = this.completedFrameCount;
    for (;;) {
      const output = this.output.replace(ANSI, "");
      const currentScreen = this.screen;
      assert.doesNotMatch(output, /Error:|TypeError/u, `TUI reported an error:\n${output}`);
      if (this.completedFrameCount > completedFrameCountBeforeWait && expected.test(currentScreen) && ready(currentScreen)) return currentScreen;
      if (this.exit) {
        assert.fail(`TUI exited early while waiting for ${String(expected)}; ${this.diagnostics}; output:\n${output}; current screen:\n${currentScreen}`);
      }
      if (Date.now() >= deadline) {
        assert.fail(`Timed out waiting for ${String(expected)}; ${this.diagnostics}; output:\n${output}; current screen:\n${currentScreen}`);
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
  let visited = session.screen;
  for (let move = 0; move < 200; move += 1) {
    if (ready.test(session.screen)) return `${visited}\n${session.screen}`;
    await session.send("\u001b[6~", new RegExp(`${ready.source}|arrows\\/Pg page`, ready.flags));
    visited += `\n${session.screen}`;
  }
  assert.fail(`preview did not reach confirmation:\n${session.screen}`);
}

test("the Xeo semantic palette reaches colored text in a real terminal", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const url = "https://example.test/xeo-palette/skills.git";
  const paletteHome = path.join(sandbox, "palette-home");
  await mkdir(paletteHome);
  const symlinkTarget = path.join(paletteHome, "portable-skill");
  await mkdir(symlinkTarget);
  await writeFile(path.join(symlinkTarget, "SKILL.md"), "---\nname: palette-link\ndescription: Palette fixture\n---\n");
  const symlinkPath = path.join(paletteHome, ".agents", "skills", "palette-link");
  await mkdir(path.dirname(symlinkPath), { recursive: true });
  await symlink(symlinkTarget, symlinkPath);
  const fixture = await fakeAppFixture(path.join(paletteHome, ".local"));
  await writeFile(fixture.file, JSON.stringify({
    name: "fixture-app",
    install: { argv: ["depot-e2e-app", "install"] },
    update: { argv: ["depot-e2e-app", "update"] },
    uninstall: { argv: ["depot-e2e-app", "uninstall"] },
    version: fixture.recipe.version,
  }));
  const environment = {
    HOME: paletteHome,
    USERPROFILE: paletteHome,
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_STATE_HOME: path.join(paletteHome, ".local", "state"),
    XDG_CONFIG_HOME: path.join(paletteHome, ".config"),
    XDG_CACHE_HOME: path.join(paletteHome, ".cache"),
    PI_CODING_AGENT_DIR: path.join(paletteHome, ".pi", "agent"),
  };
  execFileSync(process.execPath, [CLI, "source", "add", url], { cwd: projectRoot, env: { ...process.env, ...environment }, stdio: "pipe" });
  const session = new TuiSession({ ...environment, FORCE_COLOR: "3" }, 80, 24);
  try {
    await session.waitFor(/xeo-palette/u);
    await session.send("r", /Refresh these Sources\? y\/n/u);
    assert.match(session.screen, /Refresh Git Sources/u);
    assert.match(session.screen, /Source: refresh Git Source/u);
    assert.ok(session.terminalOutput.includes(ansiColor(255, 46, 154, "╭")), "header border uses the fuchsia accent");
    assert.ok(session.terminalOutput.includes(`\u001b[1m${ansiColor(255, 46, 154, "AGENT DEPOT")}`), "header name is bold fuchsia");
    assert.ok(session.terminalOutput.includes(ansiColor(192, 202, 245, `v${AGENT_DEPOT_PACKAGE_VERSION}`)), "header shows the package version in light text");
    assert.ok(session.terminalOutput.includes(ansiColor(255, 46, 154, "Refresh Git Sources")), "panel titles use the fuchsia accent");
    assert.ok(session.terminalOutput.includes(ansiColor(255, 46, 154, "▶ [1] Sources")), "the active header tab retains Xeo accent pink");
    assert.ok(session.terminalOutput.includes(ansiColor(192, 202, 245, " refresh Git Source")), "field values use Xeo brightText");
    assert.ok(session.terminalOutput.includes(ansiColor(224, 175, 104, "Refresh these Sources?")), "the decision question prefix uses Xeo warning yellow");
    assert.ok(session.terminalOutput.includes(`\u001b[1m${ansiColor(158, 206, 106, "y")}`), "yes uses bold Xeo success green");
    assert.ok(session.terminalOutput.includes(ansiColor(247, 118, 142, "n")), "no uses Xeo error red");
    await session.send("n", /LOCATION \/ STATUS/u);
    assert.ok(session.terminalOutput.includes(ansiColor(122, 162, 247, "skills")), "Sources resource types use Xeo blue");
    assert.ok(session.terminalOutput.includes(ansiColor(122, 162, 247, "app")), "App recipe type uses Xeo blue");
    assert.ok(session.terminalOutput.includes(ansiColor(224, 175, 104, "needs approval")), "unapproved recipe status uses the warning color");
    assert.equal(execFileSync(process.execPath, [CLI, "source", "list"], { cwd: projectRoot, env: { ...process.env, ...environment }, encoding: "utf8" }).includes(url), true);
    await session.send("j", /fixture-app/u);
    await session.send("\r", /Recipe approval · does not install/u);
    const appApproval = await scrollPreviewToEnd(session, /Approve fixture-app\? y\/n/u);
    assert.match(appApproval, /File:/u);
    assert.ok(session.terminalOutput.includes(ansiColor(122, 162, 247, "Version pattern:")), "App recipe field names use Xeo blue");
    assert.ok(session.terminalOutput.includes(ansiColor(192, 202, 245, " linux")), "App recipe values use Xeo brightText");
    assert.ok(session.terminalOutput.includes(`\u001b[1m${ansiColor(158, 206, 106, "y")}`), "App approval yes uses bold Xeo success green");
    assert.ok(session.terminalOutput.includes(ansiColor(247, 118, 142, "n")), "App approval no uses Xeo red");
    await session.send("y", /approved/u);
    assert.ok(session.terminalOutput.includes(ansiColor(158, 206, 106, "approved")), "approved recipe status uses the success color");
    await session.send("2", /Apps \(user-global\)/u);
    await session.send("j", /Apps \(user-global\)/u);
    const catalog = await session.send("\r", /fixture-app/u);
    assert.match(catalog, /fixture-app/u);
    assert.ok(session.terminalOutput.includes(ansiColor(224, 175, 104, "not installed")), "Catalog not-installed App status uses the warning color");
    session.resize(40, 17);
    await session.send("j", /fixture-app/u);
    assert.ok(session.screen.split("\n").length <= 17, `Catalog exceeded a 40x17 PTY:\n${session.screen}`);
    session.resize(80, 24);
    const appInstall = await session.send("i", /argv:/u);
    assert.match(appInstall, /argv:/u);
    assert.ok(session.terminalOutput.includes(ansiColor(122, 162, 247, "argv:")), "App install field names use Xeo blue");
    assert.ok(session.terminalOutput.includes(ansiColor(192, 202, 245, " [")), "App install values use Xeo brightText");
    assert.doesNotMatch(await readFile(fixture.log, "utf8").catch(() => ""), /install/u, "previewing does not execute the App recipe");
    // The preview already shows `fixture-app`; wait for the cancel result so `3` is not sent mid-transition.
    await session.send("n", /fixture-app: cancelled/u);
    const trackedDirectory = path.join(paletteHome, ".local", "state", "agent-depot", "app-installations");
    await mkdir(trackedDirectory, { recursive: true });
    const trackedFile = path.join(trackedDirectory, `${createHash("sha256").update("fixture-app").digest("hex")}.json`);
    await writeFile(trackedFile, JSON.stringify({ name: "fixture-app", recipeFile: fixture.file, installedVersion: "1.0.0" }));
    await session.send("3", /(?=.*▶ \[3\] Installations)(?=.*j\/k move · Enter expand · space mark · a all · u uninstall)(?=.*Apps \(user-global\))/su);
    await session.send("j", /(?=.*▶ \[3\] Installations)(?=.*j\/k move · Enter expand · space mark · a all · u uninstall)(?=.*>\s+Managed \(project\))/su);
    await session.send("j", /Unmanaged \(user-global\)/u);
    await session.send("j", /Apps \(user-global\)/u);
    await session.send("k", /Unmanaged \(user-global\)/u);
    await session.send("\r", /symlink/u);
    assert.ok(session.terminalOutput.includes(ansiColor(158, 206, 106, "  symlink →")), "unmanaged Skill symlink markers use green");
    await session.send("j", /symlink →/u);
    await session.send("j", /Apps \(user-global\)/u);
    if (!session.screen.includes("fixture-app")) await session.send("\r", /fixture-app/u);
    const installations = session.screen;
    assert.match(installations, /fixture-app/u);
    session.resize(40, 17);
    const selectedApp = await session.send("\x1b[B", /fixture-app/u);
    assert.ok(selectedApp.split("\n").length <= 17, `Installations exceeded a 40x17 PTY:\n${selectedApp}`);
    assert.ok(session.terminalOutput.includes(ansiColor(255, 158, 100, "1.0.0")), "the Installations App version segment uses Xeo bright yellow");
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally {
    session.kill();
  }
});

test("Profile export groups keep identities and ordinals stable across PTY resize and collapse", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const home = path.join(sandbox, "profile-groups-home");
  await mkdir(home);
  const statePath = path.join(home, ".local", "state", "agent-depot", "sources.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  const operations = createSourceOperations({ homeDirectory: home, statePath });
  const sourceUrl = `https://example.test/${"long-path-segment/".repeat(8)}profile-groups.git`;
  const source = await operations.addGitSource(sourceUrl);
  for (let index = 1; index <= 8; index++) await operations.addUserGlobalInstallation!({
    source: { kind: "external", url: source.url }, path: `skill-${index}`,
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: `.agents/skills/skill-${index}`, adopted: false },
  });
  const unmanaged = path.join(home, ".agents", "skills", `${"very-long-unmanaged-name-".repeat(3)}skill`);
  await mkdir(unmanaged, { recursive: true });
  await writeFile(path.join(unmanaged, "SKILL.md"), "---\nname: unmanaged\ndescription: fixture\n---\n");
  const environment = {
    HOME: home, USERPROFILE: home,
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
    FORCE_COLOR: "3",
  };
  const session = new TuiSession(environment, 80, 24);
  try {
    await session.waitFor(/builtin:agent-depot/u);
    await session.send("5", /Portable Profile/u);
    await session.send("e", /▸ Sources/u);
    assert.match(session.screen, /▸ Installed replicas \(8\)/u);
    assert.match(session.screen, /▸ Export notes/u);
    assert.ok(session.terminalOutput.includes(ansiColor(255, 46, 154, "Export Profile")), "Export uses the fuchsia panel title");
    await session.send("\r", /▾ Sources/u);
    await session.send("j", /▸ Source choices \(1\)/u);
    await session.send("\r", /▾ Source choices \(1\)/u);
    assert.ok(session.screen.replace(/[│\s]/g, "").includes(sourceUrl.replace(/[│\s]/g, "")),
      `80x24 expanded Sources did not show the complete URL:\n${session.screen}`);
    await session.send("j".repeat(2), /▸ Skills \(8\)/u);
    await session.send("\r", /▾ Skills \(8\)/u);
    await session.send("j", /> \[x\] 1 Skill skill-1/u);
    session.resize(40, 17);
    assert.ok(session.screen.split("\n").length <= 17, `Profile exceeded a 40x17 PTY:\n${session.screen}`);
    await session.send("\x1b[A", />.*▾ Skills \(8\)/u);
    await session.send("\x1b[D", />.*▸ Skills \(8\)/u);
    assert.doesNotMatch(session.screen, /Skill skill-1/u);
    await session.send("\x1b[C", />.*▾ Skills \(8\)/u);
    await session.send("j", /\[x\] 1 Skill skill-1/u);
    session.resize(80, 24);
    assert.ok(session.screen.split("\n").length <= 24, `Profile exceeded an 80x24 PTY:\n${session.screen}`);
    await session.send("\x1b", /e export · i import/u);
    session.resize(40, 17);
    await session.send("e", /▸ Sources/u);
    await session.send("j".repeat(2), />.*▸ Export notes/u);
    await session.send("\r", /▾ Export notes/u);
    await session.send("j".repeat(2), /> Excluded unmanaged/u);
    const selectedNote = session.screen;
    assert.ok(selectedNote.split("\n").length <= 17, `40x17 export exceeded its PTY:\n${selectedNote}`);
    const detail = await session.send("\r", /Excluded unmanag/u);
    assert.ok(detail.split("\n").length <= 17, `40x17 exclusion detail exceeded its PTY:\n${detail}`);
    assert.ok(detail.includes("[1] Sources"), `40x17 detail hid the first app tab:\n${detail}`);
    assert.ok(detail.includes("Export note"), `40x17 detail hid its title:\n${detail}`);
    const detailPages = await scrollPreviewToEnd(session, /not tracked/u);
    assert.ok(session.screen.split("\n").length <= 17, `40x17 exclusion detail page exceeded its PTY:\n${session.screen}`);
    const detailText = detail.replace(/[│\s]/g, "");
    assert.ok(detailText.includes("ExcludedunmanagedSkill"), detail);
    assert.ok(detailText.includes("very-long-unmanaged-name-very-long-unma"), detail);
    const finalDetailText = session.screen.replace(/[│\s]/g, "");
    assert.ok(finalDetailText.includes("naged-name-very-long-unmanaged-name-skill:nottracked"), detailPages);
    const restored = await session.send("\x1b", /> Excluded unmanag/u);
    assert.ok(restored.split("\n").length <= 17, `40x17 cursor restore exceeded its PTY:\n${restored}`);
    session.resize(80, 24);
    assert.match(session.screen, /> Excluded unmanag/u);
    await session.send("\x1b", /Portable Profile/u);
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally {
    session.kill();
  }
});

test("Sources refresh requires reviewing every selected Source at narrow and wide PTY sizes", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const targets = Array.from({ length: 30 }, (_, index) => `https://example.test/refresh-window-${String(index + 1).padStart(2, "2")}.git`);
  for (const [columns, rows] of [[40, 17], [80, 24]] as const) {
    const home = path.join(sandbox, `many-sources-${columns}-home`);
    await mkdir(home);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
    };
    for (const url of targets) execFileSync(process.execPath, [CLI, "source", "add", url], { cwd: projectRoot, env: { ...process.env, ...environment }, stdio: "pipe" });
    const listedSources = execFileSync(process.execPath, [CLI, "source", "list"], { cwd: projectRoot, env: { ...process.env, ...environment }, encoding: "utf8" });
    const sourceUrls = [...listedSources.matchAll(/https:\/\/example\.test\/refresh-window-\d+\.git/gu)].map(([url]) => url);
    const lastTarget = sourceUrls.at(-1);
    const session = new TuiSession(environment, columns, rows);
    try {
      await session.waitFor(/git:/u);
      await session.send("a", /\d+ selected/u);
      await session.send("r", /Refresh Git Sources/u);
      assert.match(session.screen, /Review 1 of \d+/u, `refresh review frame is incomplete:\n${session.screen}`);
      const beforeY = session.screen;
      session.press("y");
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(session.screen, beforeY, "y before the final target neither advances nor executes the refresh");

      const total = Number(/Review \d+ of (\d+)/u.exec(session.screen)?.[1] ?? 0);
      assert.ok(total > sourceUrls.length, `source ids and URLs wrap into complete physical rows: ${session.screen}`);
      const indexedRows = new Map<number, string>();
      const collectVisibleRows = () => {
        const screenRows = session.screen.split("\n");
        const range = /(\d+)–(\d+) of (\d+)/u.exec(session.screen);
        const review = /Review (\d+) of (\d+)/u.exec(session.screen);
        assert.ok(review, `preview lost its physical-row position:\n${session.screen}`);
        assert.equal(Number(review[2]), total);
        const first = range ? Number(range[1]) : 1;
        const last = range ? Number(range[2]) : total;
        const titleRow = screenRows.findIndex(row => row.includes("Refresh Git Sources"));
        const reviewRow = screenRows.findIndex(row => /Review \d+ of \d+/u.test(row));
        const visible = screenRows.slice(titleRow + 1, reviewRow)
          .map(row => row.match(/^\s*│ ?(.*?)\s*│?\s*$/u)?.[1] ?? "")
          .filter(row => row !== "" && !/^\d+–\d+ of \d+$/u.test(row));
        assert.equal(visible.length, last - first + 1, `visible rows disagree with the indexed window ${first}–${last}:\n${session.screen}`);
        visible.forEach((row, offset) => {
          const index = first + offset;
          const previous = indexedRows.get(index);
          assert.ok(previous === undefined || previous === row, `physical row ${index} changed between windows`);
          indexedRows.set(index, row);
        });
      };
      collectVisibleRows();
      const initialCursor = Number(/Review (\d+) of/u.exec(session.screen)?.[1] ?? 0);
      const initialRange = /(\d+)–(\d+) of/u.exec(session.screen);
      assert.ok(initialRange, `oversized preview should expose its visible physical rows:\n${session.screen}`);
      const pageSize = Number(initialRange[2]) - Number(initialRange[1]) + 1;
      await session.send("\u001B[B", /Review \d+ of/u);
      assert.equal(Number(/Review (\d+) of/u.exec(session.screen)?.[1]), Math.min(initialCursor + pageSize, total), "Down moves a whole visible page");
      collectVisibleRows();
      await session.send("\u001B[6~", /Review \d+ of/u);
      assert.equal(Number(/Review (\d+) of/u.exec(session.screen)?.[1]), Math.min(initialCursor + 2 * pageSize, total), "PageDown matches the arrow page step");
      collectVisibleRows();
      await session.send("\u001B[A", /Review \d+ of/u);
      assert.equal(Number(/Review (\d+) of/u.exec(session.screen)?.[1]), Math.min(initialCursor + pageSize, total), "Up reverses one visible page");
      collectVisibleRows();
      await session.send("\u001B[5~", /Review \d+ of/u);
      assert.equal(Number(/Review (\d+) of/u.exec(session.screen)?.[1]), initialCursor, "PageUp returns to the same preview rows");
      collectVisibleRows();
      for (let page = 0; page < 100 && !session.screen.includes("Refresh these Sources? y/n"); page += 1) {
        await session.send("\u001B[6~", new RegExp(`Review \\d+ of ${total}`, "u"));
        collectVisibleRows();
      }
      assert.match(session.screen, /Refresh these Sources\? y\/n/u);
      assert.ok(lastTarget, `expected registered Sources, got ${session.screen}`);
      const expectedLastLine = `Source: refresh Git Source ${sourceIdForUrl(lastTarget)} from ${lastTarget}`;
      const reviewedSources: string[] = [];
      for (const [, row] of [...indexedRows].sort(([left], [right]) => left - right)) {
        if (row.startsWith("Source: refresh Git Source ")) reviewedSources.push(row);
        else if (reviewedSources.length > 0) reviewedSources[reviewedSources.length - 1] += row;
      }
      assert.ok(reviewedSources.includes(expectedLastLine), `reviewed physical rows did not reconstruct the exact final source target:\n${JSON.stringify([...indexedRows])}`);
      await session.send("n", /\[x\] git:/u);
      session.press("q");
      assert.equal(await session.exitCode(), 0);
    } finally {
      session.kill();
    }
  }
});

test("the TUI walks every view in a real terminal and quits cleanly", { timeout: 120_000 }, async () => {
  const session = new TuiSession();
  try {
    await session.waitFor(/AGENT DEPOT[\s\S]*n add ·/u);
    assert.ok(session.terminalOutput.includes("\u001B[?1049h"), "the TUI starts in Ink's alternate screen");
    const header = session.screen.lastIndexOf("AGENT DEPOT");
    const initialFrame = session.screen.slice(session.screen.lastIndexOf("╭", header));
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
    assert.match(profile, /Portable Profile/u);
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
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
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
    assert.ok(narrowHeader.includes(`v${AGENT_DEPOT_PACKAGE_VERSION}`), `40-column header lost the package version:\n${narrowHeader}`);
    for (const destination of ["[1] Sources", "[2] Catalog", "[3] Installations", "[4] Updates", "[5] Profile"]) {
      assert.ok(narrowHeader.includes(destination), `40-column header lost ${destination}:\n${narrowHeader}`);
    }
    await session.send("2", /example.test\/packages\/pstack \(3\)/u);
    await session.send("/", /Enter submit · Esc cancel/u);
    const narrowCatalog = await session.send("pstack", /Package agent-depot-package/u);
    assert.ok(narrowCatalog.split("\n").length <= 17, `40-column PTY frame exceeded 17 rows:\n${narrowCatalog}`);
    const destinations = ["[1] Sources", "[2] Catalog", "[3] Installations", "[4] Updates", "[5] Profile"];
    const outputBeforeResize = session.terminalOutput.length;
    session.resize(80, 24);
    const resized = await session.waitFor(/Package agent-depot-package/u, () => {
      const currentScreen = session.screen;
      return session.terminalOutput.length > outputBeforeResize && currentScreen.split("\n").length >= 24 &&
        currentScreen.split("\n").some(line => destinations.every(destination => line.includes(destination)));
    });
    assert.match(resized, /AGENT DEPOT/u);
    assert.ok(resized.includes(`v${AGENT_DEPOT_PACKAGE_VERSION}`), `resized header lost the package version:\n${resized}`);
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
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
  }, 80, 24);
  try {
    await session.waitFor(/n add ·/u);
    await session.send("j", /review-all-terms[\s\S]*needs approval/u);
    const approvalQuestion = () => {
      const visible = session.screen.replace(/\s/gu, "");
      return visible.includes("Approve") && visible.includes("y/n");
    };
    let preview = await session.send("\r", /Scroll to end before y/u);
    const collectRows = (rows: Map<number, string>) => {
      const screenRows = session.screen.split("\n");
      const range = /(\d+)–(\d+) of (\d+)/u.exec(session.screen);
      const review = /Review (\d+) of (\d+)/u.exec(session.screen);
      assert.ok(review, `approval preview lost its physical-row position:\n${session.screen}`);
      const first = range ? Number(range[1]) : 1;
      const last = range ? Number(range[2]) : Number(review[2]);
      const titleRow = screenRows.findIndex(row => row.includes("Recipe approval · does not install"));
      const reviewRow = screenRows.findIndex(row => /Review \d+ of \d+/u.test(row));
      const visible = screenRows.slice(titleRow + 1, reviewRow)
        .map(row => row.match(/^\s*│ ?(.*?)\s*│?\s*$/u)?.[1] ?? "")
        .filter(row => row !== "" && !/^\d+–\d+ of \d+$/u.test(row));
      assert.equal(visible.length, last - first + 1, `visible preview rows disagree with ${first}–${last}:\n${session.screen}`);
      visible.forEach((row, offset) => rows.set(first + offset, row));
    };
    const wideRows = new Map<number, string>();
    collectRows(wideRows);
    assert.match(preview, /File:/u);
    assert.doesNotMatch(preview, /latest-selector-unchanged|Host teardown instruction/u);
    assert.ok(preview.split("\n").length <= 24, `wide preview exceeded the 24-row PTY:\n${preview}`);
    for (let move = 0; move < 80 && !approvalQuestion(); move += 1) {
      session.press("\u001b[6~");
      await new Promise(resolve => setTimeout(resolve, 20));
      collectRows(wideRows);
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
      collectRows(wideRows);
    }
    session.resize(40, 17);
    await session.send("j", /Review 2 of \d+/u);
    const narrowRows = new Map<number, string>();
    collectRows(narrowRows);
    const count = Number(/Review 2 of (\d+)/u.exec(session.screen)?.[1]);
    assert.ok(count > 14, `test recipe should exceed the 40x17 viewport: ${count}`);
    for (let move = 0; move < 120 && !approvalQuestion(); move += 1) {
      const current = /Review (\d+) of (\d+)/u.exec(session.screen);
      assert.ok(current, `preview lost its physical-row position:\n${session.screen}`);
      if (current[1] === current[2]) break;
      await session.send("j", new RegExp(`Review (?!${current[1]} of)\\d+ of`));
      collectRows(narrowRows);
    }
    const nearEnd = /Review (\d+) of (\d+)/u.exec(session.screen);
    assert.ok(nearEnd, `preview lost its position before consent:\n${session.screen}`);
    assert.ok(approvalQuestion(), `did not reach the final approval boundary:\n${session.screen}`);
    const beforeFinal = Number(nearEnd[1]) - 1;
    session.press("k");
    await new Promise(resolve => setTimeout(resolve, 20));
    collectRows(narrowRows);
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
      collectRows(narrowRows);
    }
    assert.ok(approvalQuestion(), `complete preview did not restore the approval question:\n${session.screen}`);
    assert.ok(session.screen.split("\n").length <= 17, `final preview exceeded the 17-row PTY:\n${session.screen}`);
    collectRows(narrowRows);
    const reviewed = [...wideRows, ...narrowRows].sort(([left], [right]) => left - right).map(([, line]) => line).join(" ");
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
  const updateExecutionTerm = `${"Review the exact delegated update arguments before approval. ".repeat(30)}FINAL-UPDATE-EXECUTION-TERM`;
  await writeFile(fixture.file, JSON.stringify({
    ...fixture.recipe,
    install: { ...fixture.recipe.install, manual: `${"Manual install terms remain reviewable. ".repeat(30)}FINAL-INSTALL-MANUAL-TERM` },
    update: { argv: ["depot-e2e-app", "update", "--delay", updateExecutionTerm] },
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
    PI_CODING_AGENT_DIR: path.join(previewHome, ".pi", "agent"),
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
      await session.send("\u001b[6~", /arrows\/Pg page/u);
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
    installPreview += capturedOutput(session);
    installPreview += await scrollPreviewToEnd(session, /install fixture-app\? y\/n/u);
    const continuousInstallPreview = installPreview.replace(/\s/gu, "");
    assert.ok(continuousInstallPreview.includes("argv:["), `install preview omitted JSON argv:\n${installPreview}`);
    assert.ok(continuousInstallPreview.includes("Executable:"));
    assert.ok(continuousInstallPreview.includes("depot-e2e-app"));
    assert.ok(!continuousInstallPreview.includes("Executable:…"), `install preview abbreviated the executable path:\n${installPreview}`);
    assert.ok(continuousInstallPreview.includes("Environment:linux"));
    assert.ok(continuousInstallPreview.includes("FINAL-IN") && continuousInstallPreview.includes("STALL-MANUAL-TERM"), `manual execution terms were not displayed before consent:\n${installPreview}`);
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
    await session.send(" ", /1 selected/u);
    const cancelledUpdate = await session.send("u", /Update batch preview/u);
    assert.match(cancelledUpdate, /Scroll to end before confirming/u);
    await session.send("n", /Update cancelled/u);
    assert.doesNotMatch(await readFile(fixture.log, "utf8"), /"update"/u, "cancelling the update preview does not run the recipe");
    assert.equal(await readFile(fixture.state, "utf8"), "1.0.0", "cancelling the update preview leaves the App version unchanged");
    const updatePreview = await session.send("u", /Update batch preview/u);
    assert.match(updatePreview, /Scroll to end before confirming/u);
    session.resize(40, 17);
    const narrowUpdatePreview = await session.send("j", /Review/u);
    assert.match(narrowUpdatePreview, /Review/u);
    assert.ok(session.screen.split("\n").length <= 17, `40x17 update preview exceeded its PTY:\n${session.screen}`);
    await session.send("y", /Scroll to end before confirming/u);
    assert.doesNotMatch(await readFile(fixture.log, "utf8"), /"update"/u, "y before the final page does not execute the recipe");
    assert.equal(await readFile(fixture.state, "utf8"), "1.0.0", "y before the final page leaves the App version unchanged");
    session.resize(80, 24);
    await session.send("j", /Review/u);
    const updateReview = await scrollPreviewToEnd(session, /Apply 1 update\? y\/n/u);
    assert.ok(updateReview.includes("FINAL-UPDATE-EXECUTION-TERM"), `update preview omitted its final execution term:\n${updateReview}`);
    assert.ok(session.screen.split("\n").length <= 24, `resized update preview exceeded its PTY:\n${session.screen}`);
    assert.doesNotMatch(await readFile(fixture.log, "utf8"), /"update"/u, "reviewing the update preview does not execute the recipe");
    const progress = await session.send("y", /Applying updates/u);
    assert.match(progress, /Applying updates/u);
    assert.ok(session.screen.split("\n").length <= 24, `update progress exceeded its PTY:\n${session.screen}`);
    const updateResult = await session.waitFor(/Update summary: 1 updated, 0 failed/u);
    assert.match(updateResult, /Update summary: 1 updated, 0 failed/u);
    assert.ok(session.screen.split("\n").length <= 24, `update result exceeded its PTY:\n${session.screen}`);
    assert.equal(await readFile(fixture.state, "utf8"), "2.0.0");
    assert.match(await readFile(fixture.log, "utf8"), /"update"/u, "only the confirmed update runs the recipe");
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally { session.kill(); }
});


test("wrapped Profile preview retains semantic colors while scrolling in a narrow PTY", { timeout: 120_000, skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-profile-wrapped-colors-"));
  const side = await profileSandbox(path.join(root, "side"), path.join(root, "repo"));
  const file = path.join(projectRoot, "wrapped-profile-colors.json");
  const sourceUrl = `https://example.test/${"source-segment/".repeat(14)}skills.git`;
  await writeFile(file, JSON.stringify({
    format: "agent-depot-profile/v1", agentDepotVersion: AGENT_DEPOT_PACKAGE_VERSION,
    sources: [{ url: sourceUrl, included: true }],
    skills: [{ source: { kind: "external", url: sourceUrl }, path: `skills/${"long-directory/".repeat(14)}demo`,
      hosts: ["claude", "codex", "pi"], version: { policy: "latest" } }],
    apps: [],
  }));
  const session = new TuiSession({ ...side.env, FORCE_COLOR: "3" }, 40, 17);
  try {
    await session.waitFor(/n add ·/u);
    await session.send("5", /e export · i import/u);
    await session.send("i", /Showing \.json only/u);
    await session.send("j", />\s+wrapped-profile-colors\.json/u);
    await session.send("\r", /Enter preview/u);
    const preview = await session.send("\r", /Apply Profile\? \(y\/n\)/u);
    assert.ok(preview.split("\n").length <= 17, `wrapped Profile exceeded its 40x17 PTY:\n${preview}`);
    const continuation = await session.send("j".repeat(7), /Review 8 of 41/u);
    assert.match(continuation, /7–8 of 41/u, "the narrow preview scrolls to wrapped continuation rows");
    assert.ok(session.terminalOutput.includes(ansiColor(192, 202, 245, "segment/source-segment/source-se")), "wrapped Source URL continuation retains its value color in a narrow PTY");
    await session.send("n", /Import Profile/u);
    await session.send("\u001b", /e export · i import/u);
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally {
    session.kill();
    await rm(file, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("the Profile file picker fits its wrapped guidance into a narrow real terminal", { timeout: 120_000, skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-profile-picker-layout-"));
  const side = await profileSandbox(path.join(root, "side"), path.join(root, "repo"));
  const session = new TuiSession(side.env, 40, 17);
  try {
    await session.waitFor(/n add ·/u);
    await session.send("5", /e export · i import/u);
    const picker = await session.send("i", /Showing \.json only/u);
    assert.match(picker, /Choose import file/u);
    assert.match(picker, /p full path/u);
    assert.ok(picker.split("\n").length <= 17, picker);
    await session.send("\u001b", /e export · i import/u);
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally {
    session.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("the Profile tab exports choices and imports them into a fresh HOME", { timeout: 120_000, skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-profile-tui-"));
  const sessions: TuiSession[] = [];
  try {
    const repo = path.join(root, "repo");
    const a = await profileSandbox(path.join(root, "a"), repo);
    const b = await profileSandbox(path.join(root, "b"), repo);
    await seedProfileSandbox(a, repo);
    // Both sessions run with the shared project cwd as the picker's starting directory.
    const file = path.join(projectRoot, "profile.json");
    const exporting = new TuiSession({ ...a.env, FORCE_COLOR: "3" });
    sessions.push(exporting);
    await exporting.waitFor(/n add ·/u);
    await exporting.send("5", /e export · i import/u);
    const checklist = await exporting.send("e", /Export Profile/u);
    assert.match(checklist, /▸ Sources/u);
    assert.match(checklist, /▸ Installed replicas \(2\)/u);
    assert.match(checklist, /▸ Export notes/u);
    await exporting.send("\r", /▾ Sources/u);
    await exporting.send("j", /▸ Source choices \(1\)/u);
    await exporting.send("\r", /▾ Source choices \(1\)/u);
    assert.match(exporting.screen, /\[x\] 1 https:\/\/example\.test\/profile\/source\.git/u);
    await exporting.send("j".repeat(2), /▸ Skills \(2\)/u);
    await exporting.send("\r", /▾ Skills \(2\)/u);
    assert.match(exporting.screen, /\[x\] 2 Skill skills\/alpha/u);
    await exporting.send("j".repeat(3), /▸ Apps \(2\)/u);
    await exporting.send("\r", /▾ Apps \(2\)/u);
    assert.match(exporting.screen, /App recipe fixture-app \(windows\)/u);
    // `e` from any row exports the aggregate selection into a chosen folder and file name.
    await exporting.send("e", /Use this folder/u);
    await exporting.send("\r", /Export file name/u);
    await exporting.send("\u0015", /Name: _/u);
    await exporting.send("profile.json", /Name: profile\.json_/u);
    const confirmation = await exporting.send("\r", /Save\/Export Profile\? \(y\/n\)/u);
    assert.ok(confirmation.split("\n").length <= 40, `Profile confirmation exceeded its PTY:\n${confirmation}`);
    assert.ok(confirmation.includes(`Destination: ${file}`), "Destination text is unchanged");
    assert.ok(confirmation.includes("Preview: export portable user-global profile"), "Preview text is unchanged");
    assert.ok(confirmation.includes("Skill skills/alpha [claude, pi] (latest)"), "Skill preview text is unchanged");
    assert.ok(exporting.terminalOutput.includes(ansiColor(122, 162, 247, "Destination:")), "Destination field is blue");
    assert.ok(exporting.terminalOutput.includes(ansiColor(122, 162, 247, "Skill")), "Skill category is blue");
    assert.ok(exporting.terminalOutput.includes("\u001b[1mskills/alpha"), "Skill name is bold");
    assert.ok(exporting.terminalOutput.includes(ansiColor(122, 162, 247, "claude, pi")), "Skill hosts are blue");
    assert.ok(exporting.terminalOutput.includes(ansiColor(255, 158, 100, "latest")), "Skill version policy is orange");
    assert.match(confirmation, /Save\/Export Profile\? \(y\/n\)/u);
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
    await importing.send("i", /profile\.json/u);
    await importing.send("j", />\s+profile\.json/u);
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
    await rm(file, { force: true });
  } finally {
    for (const session of sessions) session.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("a slow App install shows an advancing spinner, elapsed time from 1s, and clears when done", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-working-"));
  const home = path.join(root, "home");
  await mkdir(home);
  const fixture = await fakeAppFixture(root);
  // The fixture executable holds the install for 2.5s, so the busy line is on screen across several redraws.
  await writeFile(fixture.file, JSON.stringify({ ...fixture.recipe, install: { argv: ["depot-e2e-app", "install", "--sleep-ms=2500"] } }));
  const apps = createAppOperations({ homeDirectory: home, recipesDirectory: path.join(fixture.stateDirectory, "apps") });
  const [entry] = await apps.load();
  assert.ok(entry, "fixture recipe exists before approval");
  await apps.approve(entry);
  // isolated-env sets AGENT_DEPOT_NO_ANIMATION=1 for every test process; this journey needs the real animation.
  const session = new TuiSession({
    AGENT_DEPOT_NO_ANIMATION: "0",
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
  }, 80, 24);
  // A braille spinner glyph, the busy label and, from one second on, the elapsed time. The static `·` never matches.
  const working = /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) (?:Running|Preparing) App step…(?: (\d+)s)?/u;
  const anySpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \S[^\n]*…/u;
  const samples: Array<{ at: number; screen: string }> = [];
  let sampler: NodeJS.Timeout | undefined;
  try {
    await session.waitFor(/n add ·/u);
    await session.send("\t", /▶ \[2\] Catalog/u);
    await session.send("/", /Enter submit · Esc cancel/u);
    await session.send("fixture-app", /Filter: fixture-app/u);
    await session.send("\r", /j\/k move/u);
    await session.send("j", />\s+App fixture-app\s+not installed/u);
    await session.send("i", /Scroll to end before y|install fixture-app\? y\/n/u);
    await scrollPreviewToEnd(session, /install fixture-app\? y\/n/u);
    assert.doesNotMatch(session.screen, anySpinner, `the preview must not show a busy line:\n${session.screen}`);
    await assert.rejects(readFile(fixture.state), { code: "ENOENT" });

    const startedAt = Date.now();
    sampler = setInterval(() => samples.push({ at: Date.now(), screen: session.screen }), 20);
    session.press("y");
    const installed = await session.waitFor(/fixture-app: installed/u);
    clearInterval(sampler);
    sampler = undefined;

    const busy = samples.flatMap(({ at, screen }) => {
      const match = working.exec(screen);
      return match ? [{ at, glyph: match[1]!, seconds: match[2] === undefined ? undefined : Number(match[2]) }] : [];
    });
    assert.ok(busy.length > 0, `no spinner with a busy label was ever on screen; last frame:\n${samples.at(-1)?.screen}`);
    assert.ok(new Set(busy.map(({ glyph }) => glyph)).size >= 2, `the spinner glyph never advanced: ${[...new Set(busy.map(({ glyph }) => glyph))].join("")}`);
    // Elapsed time stays hidden under one second, then shows whole seconds that never go backwards.
    const firstElapsed = busy.find(({ seconds }) => seconds !== undefined);
    assert.ok(firstElapsed, `elapsed time never appeared on the busy line; ${busy.length} busy frames`);
    assert.ok(busy.some(({ seconds }) => seconds === undefined), "the busy line is shown before any elapsed time");
    assert.ok(busy.findIndex(({ seconds }) => seconds === undefined) < busy.indexOf(firstElapsed), "elapsed time was shown before the first second");
    assert.ok(firstElapsed.at - startedAt >= 1000, `elapsed time appeared ${firstElapsed.at - startedAt}ms after confirming, before one second had passed`);
    assert.ok(firstElapsed.seconds! >= 1);
    const seconds = busy.flatMap(({ seconds: value }) => (value === undefined ? [] : [value]));
    assert.deepEqual(seconds, [...seconds].sort((left, right) => left - right), `elapsed time went backwards: ${seconds.join(",")}`);

    // When the action finishes the busy line goes away and stays away across further redraw ticks.
    assert.doesNotMatch(installed, working, `the busy label is still shown in the result:\n${installed}`);
    assert.match(installed, /Result · complete/u);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.doesNotMatch(session.screen, anySpinner, `a busy line reappeared after the result:\n${session.screen}`);
    assert.equal(await readFile(fixture.state, "utf8"), "1.0.0");
    assert.match(await readFile(fixture.log, "utf8"), /"--sleep-ms=2500"/u, "the slow install ran through the real executable");
    session.press("q");
    assert.equal(await session.exitCode(), 0);
  } finally {
    if (sampler) clearInterval(sampler);
    session.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("a slow CLI command shows a spinner with elapsed time on a terminal and erases it before the result", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depot-cli-working-"));
  const home = path.join(root, "home");
  await mkdir(home);
  const fixture = await fakeAppFixture(root);
  await writeFile(fixture.file, JSON.stringify({ ...fixture.recipe, install: { argv: ["depot-e2e-app", "install", "--sleep-ms=2500"] } }));
  const apps = createAppOperations({ homeDirectory: home, recipesDirectory: path.join(fixture.stateDirectory, "apps") });
  const [entry] = await apps.load();
  assert.ok(entry, "fixture recipe exists before approval");
  await apps.approve(entry);
  const session = new TuiSession({
    AGENT_DEPOT_NO_ANIMATION: "0",
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
  }, 100, 24, ["app", "install", "fixture-app", "--yes"]);
  const working = /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) Installing App fixture-app…(?: (\d+)s)?/u;
  const anySpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
  const samples: Array<{ at: number; screen: string }> = [];
  const startedAt = Date.now();
  const sampler = setInterval(() => samples.push({ at: Date.now(), screen: session.screen }), 20);
  try {
    assert.equal(await session.exitCode(), 0, `the install failed:\n${session.screen}`);
    clearInterval(sampler);

    const busy = samples.flatMap(({ at, screen }) => {
      const match = working.exec(screen);
      return match ? [{ at, screen, glyph: match[1]!, seconds: match[2] === undefined ? undefined : Number(match[2]) }] : [];
    });
    assert.ok(busy.length > 0, `no spinner with the step label was ever on screen; last frame:\n${samples.at(-1)?.screen}`);
    assert.ok(new Set(busy.map(({ glyph }) => glyph)).size >= 2, "the spinner glyph never advanced");
    const firstElapsed = busy.find(({ seconds }) => seconds !== undefined);
    assert.ok(firstElapsed, `elapsed time never appeared; ${busy.length} busy frames`);
    assert.ok(firstElapsed.at - startedAt >= 1000, `elapsed time appeared after ${firstElapsed.at - startedAt}ms, before one second`);
    const seconds = busy.flatMap(({ seconds: value }) => (value === undefined ? [] : [value]));
    assert.deepEqual(seconds, [...seconds].sort((left, right) => left - right), `elapsed time went backwards: ${seconds.join(",")}`);
    // The preview printed before the step stays above the spinner, never overwritten by it.
    assert.ok(busy.every(({ screen }) => screen.includes("App fixture-app install")), "the preview stayed on screen while the spinner ran");

    // The spinner line is erased: the final screen holds the result and no spinner glyph or label.
    assert.match(session.screen, /fixture-app: installed/u);
    assert.doesNotMatch(session.screen, anySpinner, `a spinner glyph is left on screen:\n${session.screen}`);
    assert.doesNotMatch(session.screen, /Installing App/u, `the spinner label is left on screen:\n${session.screen}`);
    assert.equal(await readFile(fixture.state, "utf8"), "1.0.0");
  } finally {
    clearInterval(sampler);
    session.kill();
    await rm(root, { recursive: true, force: true });
  }
});
