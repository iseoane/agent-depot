import assert from "node:assert/strict";
import { test } from "node:test";

import { createProgress, NO_PROGRESS } from "../src/progress.js";
import { SPINNER_FRAMES, SPINNER_TICK_MS } from "../src/tui/working-model.js";
import { fakeStream, fakeTimers } from "./progress-fixtures.js";

const ERASE = "\r\u001b[2K";

function clock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance(ms: number) { current += ms; } };
}

const ANIMATED = {};
const STATIC = { AGENT_DEPOT_NO_ANIMATION: "1" };

test("a non-interactive stderr gets one plain line per step and no animation", async () => {
  const stream = fakeStream({ isTTY: false });
  const timers = fakeTimers();
  const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers });

  assert.equal(await progress.run("Cloning repo", async () => 7), 7);
  await progress.run("Installing demo…", async () => undefined);

  assert.deepEqual(stream.writes, ["Cloning repo…\n", "Installing demo…\n"]);
  assert.deepEqual(timers.intervals, []);
});

test("a stream without an isTTY flag is treated as non-interactive", async () => {
  const stream = fakeStream();
  await createProgress({ stream, env: ANIMATED, timers: fakeTimers().timers }).run("Step", async () => undefined);
  assert.deepEqual(stream.writes, ["Step…\n"]);
});

test("an interactive stderr animates the spinner, shows elapsed time from 1s and erases the line on success", async () => {
  const stream = fakeStream({ isTTY: true });
  const timers = fakeTimers();
  const time = clock();
  const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers, now: time.now });

  let release!: () => void;
  const running = progress.run("Installing demo", () => new Promise<string>((resolve) => { release = () => resolve("done"); }));
  assert.deepEqual(stream.writes, [`${ERASE}${SPINNER_FRAMES[0]} Installing demo…`]);
  assert.deepEqual(timers.intervals, [SPINNER_TICK_MS]);

  time.advance(500);
  timers.tick();
  assert.equal(stream.writes.at(-1), `${ERASE}${SPINNER_FRAMES[1]} Installing demo…`);
  time.advance(2_600);
  timers.tick();
  assert.equal(stream.writes.at(-1), `${ERASE}${SPINNER_FRAMES[2]} Installing demo… 3s`);

  release();
  assert.equal(await running, "done");
  assert.equal(stream.writes.at(-1), ERASE);
  assert.equal(timers.active, 0);
});

test("the spinner line is erased and the error propagates when the step throws", async () => {
  const stream = fakeStream({ isTTY: true });
  const timers = fakeTimers();
  const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers });

  await assert.rejects(progress.run("Updating", async () => { throw new Error("boom"); }), /boom/);

  assert.equal(stream.writes.at(-1), ERASE);
  assert.equal(timers.active, 0);
});

test("a redraw timer is unref'd and cleared after success and after a throw", async () => {
  const timers = fakeTimers();
  const progress = createProgress({ stream: fakeStream({ isTTY: true }), env: ANIMATED, timers: timers.timers });

  let during = -1;
  await progress.run("First", async () => { during = timers.active; });
  await assert.rejects(progress.run("Second", async () => { throw new Error("no"); }));

  assert.equal(during, 1);
  assert.equal(timers.active, 0);
  assert.equal(timers.everUnreffed, 2);
});

test("a step finished before any redraw leaves no stray timer or text, even with real timers", async () => {
  const stream = fakeStream({ isTTY: true });
  const progress = createProgress({ stream, env: ANIMATED });

  await progress.run("Quick", async () => undefined);
  await new Promise((resolve) => setTimeout(resolve, SPINNER_TICK_MS * 3));

  assert.deepEqual(stream.writes, [`${ERASE}${SPINNER_FRAMES[0]} Quick…`, ERASE]);
});

test("AGENT_DEPOT_NO_ANIMATION=1 on a terminal prints one static line with no timer or elapsed time", async () => {
  const stream = fakeStream({ isTTY: true });
  const timers = fakeTimers();
  const time = clock();
  const progress = createProgress({ stream, env: STATIC, timers: timers.timers, now: time.now });

  await progress.run("Installing demo", async () => { time.advance(5_000); });

  assert.deepEqual(stream.writes, ["· Installing demo…\n"]);
  assert.deepEqual(timers.intervals, []);
});

test("clear() erases a drawn spinner so printed lines are not garbled, and the next tick redraws it", async () => {
  const stream = fakeStream({ isTTY: true });
  const timers = fakeTimers();
  const progress = createProgress({ stream, env: ANIMATED, timers: timers.timers });

  await progress.run("Inspecting", async () => {
    progress.clear();
    progress.clear();
    assert.deepEqual(stream.writes.slice(1), [ERASE]);
    timers.tick();
    assert.equal(stream.writes.at(-1), `${ERASE}${SPINNER_FRAMES[1]} Inspecting…`);
  });

  assert.equal(stream.writes.at(-1), ERASE);
});

test("clear() writes nothing when no spinner is drawn", () => {
  const stream = fakeStream({ isTTY: true });
  createProgress({ stream, env: ANIMATED, timers: fakeTimers().timers }).clear();
  assert.deepEqual(stream.writes, []);
});

test("a step started inside another step is not shown separately", async () => {
  const stream = fakeStream({ isTTY: false });
  const progress = createProgress({ stream, env: ANIMATED, timers: fakeTimers().timers });

  const value = await progress.run("Outer", () => progress.run("Inner", async () => 3));

  assert.equal(value, 3);
  assert.deepEqual(stream.writes, ["Outer…\n"]);
  await progress.run("After", async () => undefined);
  assert.deepEqual(stream.writes, ["Outer…\n", "After…\n"]);
});

test("a step after a failed one is shown again", async () => {
  const stream = fakeStream({ isTTY: false });
  const progress = createProgress({ stream, env: ANIMATED, timers: fakeTimers().timers });

  await assert.rejects(progress.run("Fails", async () => { throw new Error("x"); }));
  await progress.run("Next", async () => undefined);

  assert.deepEqual(stream.writes, ["Fails…\n", "Next…\n"]);
});

test("a long label is cut to fit the terminal width so it cannot wrap", async () => {
  const stream = fakeStream({ isTTY: true, columns: 20 });
  const progress = createProgress({ stream, env: ANIMATED, timers: fakeTimers().timers });

  await progress.run("Installing a very long skill name", async () => undefined);

  const line = stream.writes[0]!.slice(ERASE.length);
  assert.ok(Array.from(line).length <= 19, line);
  assert.ok(line.endsWith("…"), line);
});

test("NO_PROGRESS runs the step and writes nothing", async () => {
  assert.equal(await NO_PROGRESS.run("Anything", async () => "ok"), "ok");
  NO_PROGRESS.clear();
});
