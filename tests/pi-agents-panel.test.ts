import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  AGENT_SNAPSHOT_REQUEST_EVENT,
  AGENT_SNAPSHOT_RESPONSE_EVENT,
  parseAgentSnapshotResponse,
  type AgentSnapshot,
} from "../resources/pi/agents-panel/contract.js";
import agentsPanelExtension, {
  AgentsPanel,
  SnapshotChannel,
  type PanelEventBus,
  type PanelTheme,
} from "../resources/pi/agents-panel/index.js";

function eventBus(): PanelEventBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
    on(channel, listener) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
  };
}

function theme(): PanelTheme {
  return {
    fg: (_color, text) => text,
    bold: (text) => text,
    style: (text) => text,
  };
}

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "agent-id",
    description: "agent task",
    subagentType: "general-purpose",
    model: "fixture-model",
    readonly: false,
    status: "completed",
    kind: "ended",
    startedAt: "2025-01-01T00:00:00.000Z",
    elapsedMs: 0,
    observed: false,
    ...overrides,
  };
}

test("the versioned pstack-shaped fixture parses without inventing missing telemetry", async () => {
  const raw = await readFile(path.resolve("tests/fixtures/pi-agents-panel/snapshot-v1.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  const response = parseAgentSnapshotResponse(parsed);
  assert.ok(response);
  assert.equal(response.agents[0]?.id, "agent-8f485c3");
  assert.equal(response.agents[0]?.usage?.input, 1200);
  assert.equal(response.agents[0]?.usage?.output, 340);
  assert.equal(response.agents[0]?.usage?.cacheWrite, undefined);
  assert.equal(response.agents[0]?.activity?.label, "bash: pnpm test");
});

function setup(rows = 24) {
  const events = eventBus();
  const channel = new SnapshotChannel({ events });
  const renders: number[] = [];
  const tui = { requestRender: () => renders.push(Date.now()), terminal: { rows } };
  const panel = new AgentsPanel(channel, tui, theme(), () => {});
  return { events, channel, panel, tui, renders };
}

type ExtensionAPI = Parameters<typeof agentsPanelExtension>[0];
type CommandRegistration = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<CommandRegistration["handler"]>[1];

function registerAgentsCommand(events: PanelEventBus): CommandRegistration["handler"] {
  let registration: CommandRegistration | undefined;
  const pi: ExtensionAPI = {
    events,
    on() {},
    registerCommand(name, options) {
      assert.equal(name, "agents");
      registration = options;
    },
  };
  agentsPanelExtension(pi);
  assert.ok(registration);
  return registration.handler;
}

function rpcContext(hasUI: boolean, notifications: string[]): CommandContext {
  return {
    mode: "rpc",
    hasUI,
    ui: {
      notify(message) {
        notifications.push(message);
      },
      async custom() {},
    },
  };
}

test("the panel explains a missing provider and does not invent agent records", () => {
  const { channel, panel } = setup();
  const requestId = channel.request();
  assert.match(panel.render(90).join("\n"), /Waiting for an agent provider/u);
  channel.markUnavailable(requestId);
  const text = panel.render(90).join("\n");
  assert.match(text, /No agent provider responded/u);
  assert.doesNotMatch(text, /running|completed|fixture-model/u);
});

test("the RPC command requests a fresh ordered snapshot with sanitized details and measured usage", async () => {
  const events = eventBus();
  const notifications: string[] = [];
  const requests: string[] = [];
  const escape = String.fromCharCode(27);
  events.on(AGENT_SNAPSHOT_REQUEST_EVENT, (payload) => {
    if (typeof payload !== "object" || payload === null || !("requestId" in payload) || typeof payload.requestId !== "string") return;
    requests.push(payload.requestId);
    events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, {
      version: 1,
      requestId: payload.requestId,
      agents: [
        agent({ id: "completed", description: "completed task", status: "completed", startedAt: "2025-01-02T00:00:00.000Z" }),
        agent({
          id: "running",
          description: "running task",
          model: `mock${escape}[31m-model${escape}[0m`,
          thinking: `high${escape}[2J`,
          status: "running",
          kind: "local",
          startedAt: "2025-01-01T00:00:00.000Z",
          activity: { label: "running command", at: 1735689600000 },
          usage: { input: 1200, output: 340, cost: 0.0034 },
        }),
      ],
    });
  });

  const handler = registerAgentsCommand(events);
  await handler("", rpcContext(true, notifications));

  assert.equal(requests.length, 1);
  assert.equal(notifications.length, 1);
  const text = notifications[0] ?? "";
  assert.ok(text.indexOf("running task") < text.indexOf("completed task"));
  assert.match(text, /mock-model/u);
  assert.match(text, /@high/u);
  assert.match(text, /running command/u);
  assert.ok(text.includes("1.2k in, 340 out, $0.0034"));
  assert.equal(text.includes(escape), false);
});

test("the RPC command reports a missing provider after its bounded request wait", async () => {
  const events = eventBus();
  let requests = 0;
  events.on(AGENT_SNAPSHOT_REQUEST_EVENT, () => requests++);
  const notifications: string[] = [];

  await registerAgentsCommand(events)("", rpcContext(true, notifications));

  assert.equal(requests, 1);
  assert.deepEqual(notifications, ["No agent provider responded. Install an adapter that publishes agent snapshots."]);
});

test("the RPC command without a UI refuses before requesting a snapshot", async () => {
  const events = eventBus();
  let requests = 0;
  events.on(AGENT_SNAPSHOT_REQUEST_EVENT, () => requests++);

  await assert.rejects(registerAgentsCommand(events)("", rpcContext(false, [])), /interactive terminal/u);
  assert.equal(requests, 0);
});

test("the panel sanitizes model, thinking, and ID before terminal rendering", () => {
  const { events, channel, panel } = setup();
  const escape = String.fromCharCode(27);
  const requestId = channel.request();
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, {
    version: 1,
    requestId,
    agents: [agent({
      id: `unsafe${escape}[31m-id`,
      model: `model${escape}[31m-name`,
      thinking: `high${escape}[2J`,
    })],
  });

  const listing = panel.render(90).join("\n");
  assert.equal(listing.includes(escape), false);
  assert.match(listing, /model-name/u);
  assert.match(listing, /@high/u);
  panel.handleInput("d");
  const details = panel.render(90).join("\n");
  assert.equal(details.includes(escape), false);
  assert.match(details, /unsafe-id/u);
});

test("the panel validates snapshots, sorts running agents first, and preserves selection by ID", () => {
  const { events, channel, panel } = setup();
  const requestId = channel.request();
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, {
    version: 1,
    requestId,
    agents: [
      agent({ id: "ended", description: "ended agent", startedAt: "2025-01-04T00:00:00.000Z" }),
      agent({ id: "running-old", description: "older running", status: "running", kind: "local", startedAt: "2025-01-02T00:00:00.000Z" }),
      agent({ id: "running-new", description: "newer running", status: "running", kind: "local", startedAt: "2025-01-03T00:00:00.000Z" }),
    ],
  });
  const lines = panel.render(100);
  const positions = ["newer running", "older running", "ended agent"].map((description) =>
    lines.findIndex((line) => line.includes(description)),
  );
  assert.deepEqual(positions, [1, 3, 5]);

  panel.handleInput("\u001b[B");
  panel.handleInput("d");
  const refreshedRequest = channel.request();
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, {
    version: 1,
    requestId: refreshedRequest,
    agents: [
      agent({ id: "running-new", description: "newer running", status: "running", kind: "local", startedAt: "2025-01-03T00:00:00.000Z" }),
      agent({ id: "running-old", description: "older running", status: "completed", kind: "ended", startedAt: "2025-01-02T00:00:00.000Z" }),
      agent({ id: "ended", description: "ended agent", startedAt: "2025-01-04T00:00:00.000Z" }),
    ],
  });
  const details = panel.render(100).join("\n");
  assert.match(details, /older running/u);
  assert.match(details, /started: 2025-01-02/u);
  assert.match(details, /status: completed/u);
});

test("a provider timeout discards its last snapshot instead of showing stale agents", async () => {
  const { events, panel } = setup();
  const requests: string[] = [];
  events.on(AGENT_SNAPSHOT_REQUEST_EVENT, (payload) => {
    if (typeof payload === "object" && payload !== null && "requestId" in payload && typeof payload.requestId === "string") {
      requests.push(payload.requestId);
    }
  });
  panel.start();
  const firstRequest = requests[0];
  assert.ok(firstRequest);
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, {
    version: 1,
    requestId: firstRequest,
    agents: [agent({ id: "last-seen", description: "last seen agent" })],
  });
  assert.match(panel.render(90).join("\n"), /last seen agent/u);

  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.ok(requests.length >= 2);
  const text = panel.render(90).join("\n");
  assert.match(text, /No agent provider responded/u);
  assert.doesNotMatch(text, /last seen agent/u);
  panel.stop();
});

test("the panel rejects malformed and stale provider responses", () => {
  const { events, channel, panel } = setup();
  const oldRequest = channel.request();
  const latestRequest = channel.request();
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, { version: 1, requestId: oldRequest, agents: [agent()] });
  assert.match(panel.render(90).join("\n"), /Waiting for an agent provider/u);
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, { version: 2, requestId: latestRequest, agents: [agent()] });
  assert.match(panel.render(90).join("\n"), /Waiting for an agent provider/u);
});

test("the panel clamps rendering to available rows and terminal columns", () => {
  const { events, channel, panel, tui } = setup(10);
  const requestId = channel.request();
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, {
    version: 1,
    requestId,
    agents: Array.from({ length: 15 }, (_, index) => agent({
      id: `agent-${index}`,
      description: `task ${index} ${"wide界".repeat(20)}`,
      startedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    })),
  });
  for (const width of [20, 8, 1]) {
    const lines = panel.render(width);
    assert.ok(lines.length <= Math.min(8, tui.terminal.rows));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  panel.handleInput("\u001b[B");
  assert.match(panel.render(60).join("\n"), /showing/u);
});

test("closing the panel stops timer renders and releases its snapshot listener", async () => {
  const { events, channel, panel, renders } = setup();
  panel.start();
  panel.handleInput("q");
  const afterClose = renders.length;
  const requestId = channel.request();
  events.emit(AGENT_SNAPSHOT_RESPONSE_EVENT, { version: 1, requestId, agents: [] });
  assert.equal(renders.length, afterClose);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(renders.length, afterClose);
});
