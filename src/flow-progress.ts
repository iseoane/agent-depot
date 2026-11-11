/** The item of an install or update batch that runs now, and its place in the batch. */
export interface FlowProgress {
  readonly kind: "skill" | "app" | "package";
  readonly name: string;
  /** 1-based. */
  readonly position: number;
  readonly total: number;
  readonly verb: "Installing" | "Updating";
}

const KIND_LABEL = { skill: "Skill", app: "App", package: "Package" } as const;

/** `Updating Skill tdd (2/5)…`; a batch of one has no position. */
export function formatProgressLabel(event: FlowProgress): string {
  const position = event.total > 1 ? ` (${event.position}/${event.total})` : "";
  return `${event.verb} ${KIND_LABEL[event.kind]} ${event.name}${position}…`;
}
