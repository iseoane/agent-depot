/** The item of an install or update batch that runs now, and its place in the batch. */
export interface FlowProgress {
  readonly kind: "skill" | "app" | "package";
  readonly name: string;
  /** 1-based. */
  readonly position: number;
  readonly total: number;
  readonly verb: "Installing" | "Updating";
}

export function formatProgressLabel(_event: FlowProgress): string {
  return "";
}
