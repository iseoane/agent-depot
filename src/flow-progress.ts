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

/** `Removing demo (2/5)…`: the shared busy label of a batch; a batch of one has no position, and the `…` marks work in progress. */
export function formatStepLabel(text: string, position: number, total: number): string {
  return `${text}${total > 1 ? ` (${position}/${total})` : ""}…`;
}

/** `Updating Skill tdd (2/5)…`. */
export function formatProgressLabel(event: FlowProgress): string {
  return formatStepLabel(`${event.verb} ${KIND_LABEL[event.kind]} ${event.name}`, event.position, event.total);
}
