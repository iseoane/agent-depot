import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

/** A one-line result shown under a list. */
export interface ViewMessage {
  readonly kind: "ok" | "error";
  readonly text: string;
}

/** True while the view is mounted, so async work never updates an unmounted view. */
export function useMounted(): MutableRefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * When the current stretch of loading began, so a loading line shows how long it has waited even
 * though the view re-renders. `seed` continues an operation that was already running (its busy start).
 */
export function useLoadingSince(loading: boolean, seed?: number): number {
  const [since, setSince] = useState<number | undefined>(() => (loading ? seed ?? Date.now() : undefined));
  useEffect(() => {
    setSince((previous) => (loading ? previous ?? seed ?? Date.now() : undefined));
  }, [loading, seed]);
  // Until the effect records it, the first loading render derives the same start.
  return since ?? seed ?? Date.now();
}

export interface Marks {
  /** For rendering. */
  readonly marked: ReadonlySet<string>;
  /** Always the latest marks, even for keys delivered in one burst. */
  readonly markedRef: MutableRefObject<ReadonlySet<string>>;
  readonly setMarked: (next: ReadonlySet<string>) => void;
}

/** Marks by node id. The ref is updated first so keys in one burst see every mark. */
export function useMarks(): Marks {
  const [marked, setMarkedState] = useState<ReadonlySet<string>>(new Set());
  const markedRef = useRef<ReadonlySet<string>>(new Set());
  const setMarked = useCallback((next: ReadonlySet<string>) => {
    markedRef.current = next;
    setMarkedState(next);
  }, []);
  return { marked, markedRef, setMarked };
}

/** `marks` with `id` added, or removed when it was marked. */
export function toggledMark(marks: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(marks);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * State mirrored in a ref that is updated first, so keys delivered in one burst
 * act on the latest value. The setter is stable.
 */
export function useMirrored<T>(initial: T): readonly [T, MutableRefObject<T>, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set];
}
