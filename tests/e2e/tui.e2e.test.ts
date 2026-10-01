import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import pty from "@homebridge/node-pty-prebuilt-multiarch";

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

  constructor() {
    // Ink renders only the final frame when it detects CI (`CI` / `CONTINUOUS_INTEGRATION`), which leaves an
    // interactive PTY blank. The session is a real terminal, so hide the CI markers from the child.
    const inherited = { ...process.env };
    delete inherited.CI;
    delete inherited.CONTINUOUS_INTEGRATION;
    this.terminal = pty.spawn(process.execPath, [CLI, "tui"], {
      name: "xterm-256color",
      cols: 110,
      rows: 40,
      cwd: projectRoot,
      env: { ...inherited, TERM: "xterm-256color", HOME: homeDirectory, USERPROFILE: homeDirectory, NO_COLOR: "1", FORCE_COLOR: "0" },
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
    await session.waitFor(/Agent Depot[\s\S]*add · r refresh/u);

    const catalog = await session.send("2", /builtin:agent-depot \(3\)[\s\S]*doctor-md-skill/u);
    assert.match(catalog, /Scope: all sources/u);

    const installations = await session.send("3", /Managed \(user-global\) \(0\)/u);
    assert.match(installations, /Unmanaged \(user-global\)/u);

    const updates = await session.send("4", /no Git sources to refresh/u);
    assert.match(updates, /Updates \(scope: all\)/u);

    const sources = await session.send("1", /builtin:agent-depot/u);
    assert.match(sources, /add · r refresh/u);

    // `n` opens the add-Source prompt (keys are captured), Esc cancels back to the list.
    await session.send("n", /Enter submit · Esc cancel/u);
    await session.send("\u001b", /add · r refresh/u);

    // `/` opens the Catalog filter and narrows the list.
    await session.send("2", /doctor-md-skill/u);
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
