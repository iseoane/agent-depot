export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What happened to one item of a batch: the line to show, and whether it was applied. */
export interface BatchOutcome<T> {
  readonly item: T;
  readonly ok: boolean;
  readonly line: string;
}

/**
 * Applies the items one after another. A failure is reported for that item and
 * the rest still run, so the outcomes always cover every item in order.
 */
export async function runBatch<T>(
  items: readonly T[],
  run: (item: T) => Promise<string>,
  describeFailure: (item: T, error: unknown) => string,
): Promise<readonly BatchOutcome<T>[]> {
  const outcomes: BatchOutcome<T>[] = [];
  for (const item of items) {
    try {
      outcomes.push({ item, ok: true, line: await run(item) });
    } catch (error) {
      outcomes.push({ item, ok: false, line: describeFailure(item, error) });
    }
  }
  return outcomes;
}
