import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { render } from "ink-testing-library";

import { Working } from "../src/tui/panel-parts.js";
import { animationEnabled, busy, formatElapsed, isWorkingFrame, SPINNER_FRAMES } from "../src/tui/working-model.js";
import { waitForFrame } from "./wait-for-frame.js";

test("formatElapsed hides the first second, then counts seconds and minutes", () => {
  assert.equal(formatElapsed(0), "");
  assert.equal(formatElapsed(999), "");
  assert.equal(formatElapsed(1000), "1s");
  assert.equal(formatElapsed(12_900), "12s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m 00s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(3_725_000), "62m 05s");
  assert.equal(formatElapsed(Number.NaN), "");
});

test("animation is off only for AGENT_DEPOT_NO_ANIMATION=1", () => {
  assert.equal(animationEnabled({}), true);
  assert.equal(animationEnabled({ AGENT_DEPOT_NO_ANIMATION: "0" }), true);
  assert.equal(animationEnabled({ AGENT_DEPOT_NO_ANIMATION: "1" }), false);
});

test("isWorkingFrame tells a Working line from content", () => {
  assert.equal(isWorkingFrame("⠹ Installing foo… 3s"), true);
  assert.equal(isWorkingFrame("· Loading catalog…\n"), true);
  assert.equal(isWorkingFrame("▸ Skills\n  alpha"), false);
});

test("Working advances the spinner frame while animating", async (t) => {
  const { lastFrame, unmount } = render(<Working label="Installing foo…" since={Date.now()} animate />);
  t.after(unmount);
  const first = lastFrame() ?? "";
  assert.ok(SPINNER_FRAMES.some((frame) => first.startsWith(`${frame} Installing foo…`)), first);
  const next = await waitForFrame(lastFrame, (frame) => frame !== first);
  assert.ok(SPINNER_FRAMES.some((frame) => next.startsWith(`${frame} Installing foo…`)), next);
});

test("Working shows elapsed time only from one second on", async (t) => {
  let clock = 10_000;
  const { lastFrame, unmount } = render(<Working label="Installing foo…" since={10_000} now={() => clock} animate />);
  t.after(unmount);
  assert.doesNotMatch(lastFrame() ?? "", /\d+s/);
  clock = 13_000;
  assert.match(await waitForFrame(lastFrame, /Installing foo… 3s$/m), /Installing foo… 3s/);
  clock = 75_000;
  await waitForFrame(lastFrame, /Installing foo… 1m 05s$/m);
});

test("Working keeps counting from `since` when the label changes", async (t) => {
  let clock = 0;
  const view = render(<Working label="Refreshing sources…" since={0} now={() => clock} animate />);
  t.after(view.unmount);
  clock = 4000;
  await waitForFrame(view.lastFrame, /Refreshing sources… 4s$/m);
  view.rerender(<Working label="Checking for updates…" since={0} now={() => clock} animate />);
  await waitForFrame(view.lastFrame, /Checking for updates… 4s$/m);
  // A new operation passes a new start time.
  clock = 5000;
  view.rerender(<Working label="Applying updates…" since={5000} now={() => clock} animate />);
  const frame = await waitForFrame(view.lastFrame, /Applying updates…/);
  assert.doesNotMatch(frame, /\d+s/);
});

test("Working without animation is one static line with no timer", async (t) => {
  const setIntervalMock = mock.method(globalThis, "setInterval");
  t.after(() => setIntervalMock.mock.restore());
  const { lastFrame, unmount } = render(<Working label="Installing foo…" since={0} now={() => 90_000} animate={false} />);
  t.after(unmount);
  assert.equal(lastFrame(), "· Installing foo…");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(lastFrame(), "· Installing foo…");
  assert.equal(setIntervalMock.mock.callCount(), 0);
});

test("Working clears an unref'd timer on unmount", (t) => {
  const timers: NodeJS.Timeout[] = [];
  const realSetInterval = globalThis.setInterval;
  const setIntervalMock = mock.method(globalThis, "setInterval", ((...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args);
    timers.push(timer);
    return timer;
  }) as typeof setInterval);
  const clearIntervalMock = mock.method(globalThis, "clearInterval");
  t.after(() => { setIntervalMock.mock.restore(); clearIntervalMock.mock.restore(); });
  const { unmount } = render(<Working label="Installing foo…" since={Date.now()} animate />);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.hasRef(), false);
  unmount();
  assert.ok(clearIntervalMock.mock.calls.some((call) => call.arguments[0] === timers[0]));
});

test("busy keeps the start time of an operation already busy and restarts otherwise", () => {
  const first = busy("Refreshing sources…", { kind: "browse" }, () => 100);
  assert.deepEqual(first, { kind: "busy", label: "Refreshing sources…", startedAt: 100 });
  assert.deepEqual(busy("Checking for updates…", first, () => 500), { kind: "busy", label: "Checking for updates…", startedAt: 100 });
  assert.equal(busy("Applying…", { kind: "browse" }, () => 900).startedAt, 900);
  assert.equal(busy("Applying…", undefined, () => 700).startedAt, 700);
});
