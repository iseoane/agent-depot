import assert from "node:assert/strict";
import { test } from "node:test";

import { runProcess, withChildOutput, type ProcessRunOptions } from "../src/process-runner.js";
import { createProgress as createBareProgress, type Progress, type ProgressOptions } from "../src/progress.js";
import { fakeStream, fakeTimers, screenOf } from "./progress-fixtures.js";

/**
 * Child output reaches the user through progress: a tail under the spinner on an interactive stderr,
 * every line live under `--verbose`, nothing otherwise. The real runner and real child processes
 * drive each scenario; progress is observed through a fake stderr and a replayed terminal.
 */

/** The reporter as the CLI builds it: child output is tapped through the process runner. */
const createProgress = (options: ProgressOptions): Progress => createBareProgress({ tapChildOutput: withChildOutput, ...options });

const ANIMATED = {};
const STATIC = { AGENT_DEPOT_NO_ANIMATION: "1" };

/** A child that writes `chunks` straight to stdout/stderr (unbuffered), then stays alive so the step is still running. */
function chatter(chunks: ReadonlyArray<readonly [1 | 2, string]>, lingerMs = 300): string[] {
  const writes = chunks.map(([fd, text]) => `fs.writeSync(${fd},${JSON.stringify(text)});`).join("");
  return ["-e", `const fs=require("node:fs");${writes}setTimeout(()=>{},${lingerMs});`];
}

/** Runs `args` under a progress step while firing the redraw timer, returning the screen as seen mid-step and after it. */
async function observe(
  progress: Progress,
  stream: ReturnType<typeof fakeStream>,
  timers: ReturnType<typeof fakeTimers>,
  args: readonly string[],
  options: ProcessRunOptions = {},
  runOptions: { readonly mayPrompt?: boolean } = {},
) {
  const frames: string[][] = [];
  const ticker = setInterval(() => {
    timers.tick();
    frames.push(screenOf(stream.writes, stream.columns));
  }, 15);
  try {
    const result = await progress.run("Installing demo", () => runProcess(process.execPath, args, options), runOptions);
    return { result, frames, final: screenOf(stream.writes, stream.columns) };
  } finally {
    clearInterval(ticker);
  }
}

const FIVE_LINES = chatter([[1, "line 1\nline 2\nline 3\n"], [2, "line 4\nline 5\n"]]);

test("an interactive stderr shows the last three child lines under the spinner and erases them with it", async () => {
  const stream = fakeStream({ isTTY: true, columns: 60, rows: 24 });
  const timers = fakeTimers();
  const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers });

  const { frames, final } = await observe(progress, stream, timers, FIVE_LINES);

  const full = frames.filter((rows) => rows.includes("  line 5"));
  assert.ok(full.length > 0, `the newest line never reached the screen: ${JSON.stringify(frames.at(-1))}`);
  const tail = full.at(-1)!;
  assert.match(tail[0]!, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Installing demo…/u);
  assert.deepEqual(tail.slice(1), ["  line 3", "  line 4", "  line 5"]);
  assert.deepEqual(final, [""], "the spinner and its tail are erased together");
});

test("a tail line is cut to the terminal width so a redraw never wraps", async () => {
  const stream = fakeStream({ isTTY: true, columns: 20, rows: 24 });
  const timers = fakeTimers();
  const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers });

  const { frames, final } = await observe(progress, stream, timers, chatter([[1, `${"x".repeat(50)}\n`]]));

  const withTail = frames.find((rows) => rows.length > 1);
  assert.ok(withTail, "no tail was drawn");
  assert.equal(withTail.length, 2, "the long line must stay on one row");
  assert.equal(withTail[1], `  ${"x".repeat(16)}…`);
  assert.deepEqual(final, [""]);
});

test("a step that may prompt stays static and never draws child output", async () => {
  const stream = fakeStream({ isTTY: true, columns: 60, rows: 24 });
  const timers = fakeTimers();
  const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers });

  const { final } = await observe(progress, stream, timers, FIVE_LINES, {}, { mayPrompt: true });

  assert.deepEqual(stream.writes, ["· Installing demo…\n"]);
  assert.deepEqual(final, ["· Installing demo…", ""]);
  assert.deepEqual(timers.intervals, []);
});

test("without an interactive animated stderr there is no tail, exactly as before", async () => {
  for (const [stream, env] of [
    [fakeStream({ isTTY: false }), ANIMATED],
    [fakeStream({ isTTY: true, columns: 60, rows: 24 }), STATIC],
  ] as const) {
    const timers = fakeTimers();
    const progress = createProgress({ stream, env, timers: timers.timers });
    await observe(progress, stream, timers, FIVE_LINES);
    assert.equal(stream.writes.length, 1, JSON.stringify(stream.writes));
    assert.match(stream.writes[0]!, /^(?:· )?Installing demo…\n$/u);
    assert.deepEqual(timers.intervals, []);
  }
});

test("verbose streams every child line live to stderr after one plain step line, with no spinner", async () => {
  for (const isTTY of [true, false]) {
    const stream = fakeStream({ isTTY, columns: 60, rows: 24 });
    const timers = fakeTimers();
    const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers, verbose: true });

    await observe(progress, stream, timers, chatter([[1, "out 1\nout 2\n"], [2, "err 1\n"], [1, "tail without newline"]]));

    const lines = stream.writes.join("").split("\n");
    assert.equal(lines[0], `${isTTY ? "· " : ""}Installing demo…`);
    assert.deepEqual(lines.slice(1).sort(), ["", "err 1", "out 1", "out 2", "tail without newline"].sort());
    assert.ok(stream.writes.every((write) => !write.includes("\u001b")), "verbose never redraws");
    assert.deepEqual(timers.intervals, []);
  }
});

test("verbose also streams a step that may prompt, and strips terminal escapes and carriage-return progress", async () => {
  const stream = fakeStream({ isTTY: false });
  const progress = createProgress({ stream, env: ANIMATED, timers: fakeTimers().timers, verbose: true });

  await progress.run("Fetching", () => runProcess(process.execPath, chatter([[2, "\u001b[31mred\u001b[0m\n10%\r50%\r100%\n"]], 0), {}), { mayPrompt: true });

  assert.equal(stream.writes.join(""), "Fetching…\nred\n100%\n");
});

test("child stdout that a caller captures as data is not shown unless it opts in; stderr always is", async () => {
  const run = async (options: ProcessRunOptions) => {
    const stream = fakeStream({ isTTY: false });
    const progress = createProgress({ stream, env: ANIMATED, timers: fakeTimers().timers, verbose: true });
    const result = await progress.run("Step", () => runProcess(process.execPath, chatter([[1, "data\n"], [2, "log\n"]], 0), options));
    return { shown: stream.writes.join(""), stdout: result.stdout.toString("utf8") };
  };

  assert.deepEqual(await run({ captureStdout: true }), { shown: "Step…\nlog\n", stdout: "data\n" });
  assert.deepEqual(await run({ captureStdout: true, streamStdout: true }), { shown: "Step…\ndata\nlog\n", stdout: "data\n" });
  assert.deepEqual(await run({}), { shown: "Step…\ndata\nlog\n", stdout: "" });
});

test("showing child output leaves the run result, caps and timeout shapes unchanged", async () => {
  // Each cap case floods one stream only: with both, whether the other stream's bytes arrive before the kill is a race.
  const flood = (fd: 1 | 2, bytes: number) => ["-e", `require("node:fs").writeSync(${fd},"x".repeat(${bytes}));setTimeout(()=>{},5000);`];
  const cases: Array<[string, readonly string[], ProcessRunOptions]> = [
    ["exit code and captured output", ["-e", `console.log("hi");console.error("oops");process.exitCode=3`], { captureStdout: true }],
    ["stdout cap", flood(1, 5000), { captureStdout: true, maxOutputBytes: 1000 }],
    ["stderr cap", flood(2, 5000), { maxStderrBytes: 100 }],
    ["timeout", flood(2, 300), { timeoutMs: 200 }],
  ];
  for (const [name, args, options] of cases) {
    const bare = await runProcess(process.execPath, args, options);
    const shown = await createProgress({ stream: fakeStream({ isTTY: false }), env: ANIMATED, timers: fakeTimers().timers, verbose: true })
      .run("Step", () => runProcess(process.execPath, args, options));
    assert.deepEqual(shown, bare, name);
  }
});
