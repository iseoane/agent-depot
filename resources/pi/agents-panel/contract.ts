import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const agentActivitySchema = Type.Object({
  label: Type.String(),
  at: Type.Number(),
});

const agentUsageSchema = Type.Object({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
  totalTokens: Type.Optional(Type.Number()),
  cost: Type.Optional(Type.Number()),
});

const agentSchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  subagentType: Type.String(),
  model: Type.String(),
  thinking: Type.Optional(Type.String()),
  readonly: Type.Boolean(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("stopped"),
  ]),
  kind: Type.Union([Type.Literal("local"), Type.Literal("remote"), Type.Literal("ended")]),
  pid: Type.Optional(Type.Number()),
  startedAt: Type.String(),
  endedAt: Type.Optional(Type.String()),
  elapsedMs: Type.Number(),
  observed: Type.Boolean(),
  activity: Type.Optional(agentActivitySchema),
  usage: Type.Optional(agentUsageSchema),
  worktree: Type.Optional(Type.String()),
});

export const agentSnapshotRequestSchema = Type.Object({
  version: Type.Literal(1),
  requestId: Type.String(),
});

export const agentSnapshotResponseSchema = Type.Object({
  version: Type.Literal(1),
  requestId: Type.String(),
  agents: Type.Array(agentSchema),
});

export type AgentSnapshot = Static<typeof agentSchema>;
export type AgentSnapshotRequest = Static<typeof agentSnapshotRequestSchema>;
export type AgentSnapshotResponse = Static<typeof agentSnapshotResponseSchema>;

export const AGENT_SNAPSHOT_REQUEST_EVENT = "agent-depot:agents:v1:request";
export const AGENT_SNAPSHOT_RESPONSE_EVENT = "agent-depot:agents:v1:snapshot";

export function parseAgentSnapshotResponse(value: unknown): AgentSnapshotResponse | undefined {
  return Value.Check(agentSnapshotResponseSchema, value) ? value : undefined;
}
