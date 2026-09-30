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
