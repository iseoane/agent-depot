import { Key, matchesKey, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import {
  AGENT_SNAPSHOT_REQUEST_EVENT,
  AGENT_SNAPSHOT_RESPONSE_EVENT,
  parseAgentSnapshotResponse,
  type AgentSnapshot,
} from "./contract.js";

const TICK_MS = 1000;
const RESPONSE_TIMEOUT_MS = 2000;
const OVERLAY_MARGIN = 1;
const OVERLAY_MAX_HEIGHT_PERCENT = 80;
const MAX_AGENTS = 12;

type SnapshotState =
  | { readonly kind: "waiting" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly requestId: string; readonly agents: readonly AgentSnapshot[] };

export interface PanelEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface PanelTheme {
  fg(color: "accent" | "dim" | "muted" | "success" | "error" | "warning", text: string): string;
  bold(text: string): string;
  style(text: string, options: { readonly bg: "selectedBg" }): string;
}

interface PanelCommandContext {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly ui: {
    notify(message: string, type: "info"): void;
    custom(
      factory: (
        tui: { requestRender(): void; terminal?: { readonly rows: number } },
        theme: PanelTheme,
        keybindings: unknown,
        done: (result: undefined) => void,
      ) => Component,
      options: {
        readonly overlay: true;
        readonly overlayOptions: {
          readonly width: "80%";
          readonly minWidth: 40;
          readonly maxHeight: string;
          readonly anchor: "center";
          readonly margin: number;
        };
      },
    ): Promise<void>;
  };
}

interface PanelExtensionAPI {
  readonly events: PanelEventBus;
  on(event: "session_shutdown", handler: () => void): void;
  registerCommand(name: string, options: {
    readonly description: string;
    readonly handler: (args: string, ctx: PanelCommandContext) => Promise<void>;
  }): void;
}

export class SnapshotChannel {
  private current: SnapshotState = { kind: "waiting" };
  private nextRequestId = 0;
  private latestRequestId: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly pi: Pick<PanelExtensionAPI, "events">) {
    pi.events.on(AGENT_SNAPSHOT_RESPONSE_EVENT, (payload) => {
      const response = parseAgentSnapshotResponse(payload);
      if (!response || response.requestId !== this.latestRequestId) return;
      this.current = { kind: "available", requestId: response.requestId, agents: response.agents };
      this.notify();
    });
  }

  get state(): SnapshotState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(): string {
    const requestId = String(++this.nextRequestId);
    this.latestRequestId = requestId;
    this.pi.events.emit(AGENT_SNAPSHOT_REQUEST_EVENT, { version: 1, requestId });
    return requestId;
  }

  markUnavailable(requestId: string): void {
    if (this.latestRequestId !== requestId || this.current.kind === "unavailable") return;
    this.current = { kind: "unavailable" };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

interface PanelLine {
  readonly text: string;
  readonly selected?: boolean;
}

function sanitize(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function usageLine(usage: NonNullable<AgentSnapshot["usage"]>): string {
  const values: string[] = [];
  if (usage.input !== undefined) values.push(`${formatTokens(usage.input)} in`);
  if (usage.output !== undefined) values.push(`${formatTokens(usage.output)} out`);
  if (usage.cacheRead !== undefined || usage.cacheWrite !== undefined) {
    values.push(`${formatTokens((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))} cached`);
  }
  if (usage.cost !== undefined) values.push(`$${usage.cost.toFixed(4)}`);
  if (!values.length && usage.totalTokens !== undefined) values.push(`${formatTokens(usage.totalTokens)} tokens`);
  return values.join(", ");
}

function orderAgents(agents: readonly AgentSnapshot[]): AgentSnapshot[] {
  return [...agents].sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (left.status !== "running" && right.status === "running") return 1;
    const leftStarted = Date.parse(left.startedAt);
    const rightStarted = Date.parse(right.startedAt);
    if (Number.isNaN(leftStarted)) return Number.isNaN(rightStarted) ? 0 : 1;
    if (Number.isNaN(rightStarted)) return -1;
    return rightStarted - leftStarted;
  });
}

export class AgentsPanel implements Component {
  private cursor = 0;
  private selectedId: string | undefined;
  private detail = false;
  private detailScroll = 0;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private responseTimeout: NodeJS.Timeout | undefined;
  private pendingRequest: string | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly channel: SnapshotChannel,
    private readonly tui: { requestRender(): void; terminal?: { readonly rows: number } },
    private readonly theme: PanelTheme,
    private readonly close: () => void,
  ) {
    this.unsubscribe = channel.subscribe(() => {
      if (channel.state.kind === "available" && channel.state.requestId === this.pendingRequest) {
        if (this.responseTimeout) clearTimeout(this.responseTimeout);
        this.responseTimeout = undefined;
        this.pendingRequest = undefined;
      }
      tui.requestRender();
    });
  }

  start(): void {
    if (this.timer) return;
    this.requestSnapshot();
    this.timer = setInterval(() => this.requestSnapshot(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.responseTimeout) clearTimeout(this.responseTimeout);
    this.timer = undefined;
    this.responseTimeout = undefined;
    this.pendingRequest = undefined;
    this.unsubscribe();
  }

  dispose(): void {
    this.stop();
  }

  invalidate(): void {}

  private requestSnapshot(): void {
    if (this.closed || this.pendingRequest) return;
    const requestId = this.channel.request();
    if (this.channel.state.kind === "available" && this.channel.state.requestId === requestId) return;
    this.pendingRequest = requestId;
    this.responseTimeout = setTimeout(() => {
      if (this.pendingRequest !== requestId) return;
      this.responseTimeout = undefined;
      this.pendingRequest = undefined;
      this.channel.markUnavailable(requestId);
    }, RESPONSE_TIMEOUT_MS);
    this.responseTimeout.unref();
  }

  handleInput(data: string): void {
    if (data === "q") return this.finish();
    if (matchesKey(data, Key.escape)) {
      if (this.detail) {
        this.detail = false;
        this.detailScroll = 0;
        this.tui.requestRender();
        return;
      }
      return this.finish();
    }
    if (matchesKey(data, Key.enter) || data === "d") {
      if (this.channel.state.kind !== "available" || this.channel.state.agents.length === 0) return;
      this.detail = !this.detail;
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    const up = matchesKey(data, Key.up) || data === "k";
    const down = matchesKey(data, Key.down) || data === "j";
    if (!up && !down) return;
    if (this.detail) {
      this.detailScroll = Math.max(0, this.detailScroll + (down ? 1 : -1));
    } else if (this.channel.state.kind === "available") {
      const agents = orderAgents(this.channel.state.agents);
      this.syncSelection(agents);
      this.cursor = down ? Math.min(Math.max(0, agents.length - 1), this.cursor + 1) : Math.max(0, this.cursor - 1);
      this.selectedId = agents[this.cursor]?.id;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const available = this.channel.state;
    if (available.kind !== "available") {
      const message = available.kind === "waiting"
        ? "Waiting for an agent provider."
        : "No agent provider responded. Install an adapter that publishes agent snapshots.";
      return this.fit(this.frame({ text: this.heading("Agents") }, [{ text: "" }, { text: this.theme.fg("muted", message) }], "q close", this.overlayRows()), Math.max(1, width));
    }
    const agents = orderAgents(available.agents);
    if (agents.length === 0) {
      this.syncSelection(agents);
      return this.fit(this.frame({ text: this.heading("Agents") }, [{ text: "" }, { text: this.theme.fg("muted", "No agent has been started in this session.") }], "q close", this.overlayRows()), Math.max(1, width));
    }
    this.syncSelection(agents);
    const selected = agents[this.cursor];
    if (!selected) return this.fit(this.frame({ text: this.heading("Agents") }, [], "q close", this.overlayRows()), Math.max(1, width));
    const lines = this.detail ? this.detailLines(selected, this.overlayRows()) : this.listLines(agents, this.overlayRows());
    return this.fit(lines, Math.max(1, width));
  }

  private syncSelection(agents: readonly AgentSnapshot[]): void {
    if (!agents.length) {
      this.cursor = 0;
      this.selectedId = undefined;
      return;
    }
    const selectedIndex = this.selectedId ? agents.findIndex((agent) => agent.id === this.selectedId) : -1;
    this.cursor = selectedIndex >= 0 ? selectedIndex : Math.min(this.cursor, agents.length - 1);
    this.selectedId = agents[this.cursor]?.id;
  }

  private finish(): void {
    this.stop();
    this.close();
  }

  private fit(lines: readonly PanelLine[], width: number): string[] {
    return lines.map(({ text, selected }) => {
      const fitted = truncateToWidth(text, width, "...", true);
      return selected ? this.theme.style(fitted, { bg: "selectedBg" }) : fitted;
    });
  }

  private heading(text: string): string {
    return this.theme.fg("accent", this.theme.bold(text));
  }

  private hint(text: string): string {
    return this.theme.fg("dim", text);
  }

  private overlayRows(): number {
    const rows = Math.max(1, Math.floor(this.tui.terminal?.rows || 24));
    return Math.max(1, Math.min(Math.floor((rows * OVERLAY_MAX_HEIGHT_PERCENT) / 100), Math.max(1, rows - OVERLAY_MARGIN * 2)));
  }

  private frame(heading: PanelLine, body: readonly PanelLine[], help: string, limit: number): PanelLine[] {
    const lines = [heading, ...body.slice(0, Math.max(0, limit - 2)), { text: this.hint(help) }];
    return lines.length <= limit ? lines : [{ text: this.hint(help) }];
  }

  private listLines(agents: readonly AgentSnapshot[], limit: number): PanelLine[] {
    const running = agents.filter((agent) => agent.status === "running").length;
    const budget = Math.min(MAX_AGENTS, Math.max(1, Math.floor(Math.max(0, limit - 2) / 2)));
    const start = Math.min(Math.max(0, this.cursor - Math.floor(budget / 2)), Math.max(0, agents.length - budget));
    const visible = agents.slice(start, start + budget);
    const shown = agents.length > visible.length ? `, showing ${start + 1}-${start + visible.length}` : "";
    const body: PanelLine[] = [];
    visible.forEach((agent, index) => {
      const selected = start + index === this.cursor;
      body.push({ text: this.row(agent, selected), selected }, { text: this.meta(agent), selected });
    });
    return this.frame({ text: this.heading(`Agents (${running} running, ${agents.length} total${shown})`) }, body, "up/down select   enter details   q close", limit);
  }

  private row(agent: AgentSnapshot, selected: boolean): string {
    const mark = agent.status === "running" ? ">" : agent.status === "completed" ? "+" : agent.status === "failed" ? "x" : "-";
    const color = agent.status === "running" ? "accent" : agent.status === "completed" ? "success" : agent.status === "failed" ? "error" : "warning";
    return `${selected ? "*" : " "} ${this.theme.fg(color, mark)} ${this.theme.fg("muted", agent.id.slice(0, 8))}  ${sanitize(agent.description)}`;
  }

  private meta(agent: AgentSnapshot): string {
    const fields = [agent.model];
    if (agent.thinking) fields.push(`@${agent.thinking}`);
    fields.push(formatElapsed(agent.elapsedMs));
    if (agent.usage) fields.push(usageLine(agent.usage));
    fields.push(agent.activity ? sanitize(agent.activity.label) : "no activity seen");
    return `   ${this.theme.fg("dim", fields.join("  "))}`;
  }

  private detailLines(agent: AgentSnapshot, limit: number): PanelLine[] {
    const lines: PanelLine[] = [
      { text: this.heading(sanitize(agent.description)) },
      { text: this.theme.fg("muted", agent.id) },
      { text: "" },
      { text: `${this.theme.fg("muted", "status:")} ${agent.status}` },
      { text: `${this.theme.fg("muted", "type:")} ${sanitize(agent.subagentType)}` },
      { text: `${this.theme.fg("muted", "model:")} ${sanitize(agent.thinking ? `${agent.model} @${agent.thinking}` : agent.model)}` },
      { text: `${this.theme.fg("muted", "readonly:")} ${agent.readonly ? "yes" : "no"}` },
      { text: `${this.theme.fg("muted", "started:")} ${sanitize(agent.startedAt)}` },
      { text: `${this.theme.fg("muted", "elapsed:")} ${formatElapsed(agent.elapsedMs)}${agent.endedAt ? " (final)" : ""}` },
      { text: `${this.theme.fg("muted", "activity:")} ${agent.activity ? sanitize(agent.activity.label) : "none observed"}` },
      { text: `${this.theme.fg("muted", "tokens:")} ${agent.usage ? usageLine(agent.usage) : agent.observed ? "none reported" : "not captured"}` },
      { text: `${this.theme.fg("muted", "telemetry:")} ${agent.kind === "local" ? "live from this process" : agent.kind === "remote" ? "held by another pi process" : agent.observed ? "captured when the run ended" : "not captured (restored record)"}` },
    ];
    if (agent.worktree) lines.push({ text: `${this.theme.fg("muted", "worktree:")} ${sanitize(agent.worktree)}` });
    const viewport = Math.max(0, limit - 1);
    const maxScroll = Math.max(0, lines.length - viewport);
    this.detailScroll = Math.min(Math.max(0, this.detailScroll), maxScroll);
    const help = maxScroll > 0 ? "up/down scroll   esc back   q close" : "esc back   q close";
    if (viewport === 0) return [{ text: this.hint(help) }];
    return [...lines.slice(this.detailScroll, this.detailScroll + viewport), { text: this.hint(help) }];
  }
}

class AgentSnapshotPanelExtension {
  readonly channel: SnapshotChannel;
  private active: AgentsPanel | undefined;

  constructor(private readonly pi: PanelExtensionAPI) {
    this.channel = new SnapshotChannel(pi);
  }

  register(): void {
    this.pi.on("session_shutdown", () => {
      this.active?.stop();
      this.active = undefined;
    });
    this.pi.registerCommand("agents", {
      description: "Show this session's agents",
      handler: async (_args, ctx: PanelCommandContext) => {
        if (ctx.mode !== "tui") {
          if (ctx.hasUI) {
            const state = this.channel.state;
            const text = state.kind === "available"
              ? state.agents.length === 0 ? "No agent has been started in this session." : `${state.agents.length} agent(s) are available. Run /agents in an interactive terminal to inspect them.`
              : state.kind === "waiting"
                ? "Run /agents in an interactive terminal to request an agent snapshot."
                : "No agent provider responded. Install an adapter that publishes agent snapshots.";
            ctx.ui.notify(text, "info");
            return;
          }
          throw new Error("The /agents panel needs an interactive terminal.");
        }
        let panel: AgentsPanel | undefined;
        try {
          await ctx.ui.custom(
            (tui, theme, _keybindings, done) => {
              panel = new AgentsPanel(this.channel, tui, theme, () => done(undefined));
              this.active = panel;
              panel.start();
              return panel;
            },
            { overlay: true, overlayOptions: { width: "80%", minWidth: 40, maxHeight: `${OVERLAY_MAX_HEIGHT_PERCENT}%`, anchor: "center", margin: OVERLAY_MARGIN } },
          );
        } finally {
          panel?.stop();
          if (this.active === panel) this.active = undefined;
        }
      },
    });
  }
}

export default function agentsPanel(pi: PanelExtensionAPI): void {
  const thisExtension = new AgentSnapshotPanelExtension(pi);
  thisExtension.register();
}
