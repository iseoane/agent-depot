import { useInput, type Key } from "ink";
import { useRef } from "react";

export type KeyHandler = (input: string, key: Key) => void;

/** Plain printable characters only: control characters and escape sequences are never split. */
const PRINTABLE = /^[^\p{Cc}]+$/u;

/**
 * Ink strips the ESC of sequences it does not resolve and hands over the rest
 * (`[200~` paste markers, `[I` focus events, `[<0;10;5M` mouse reports). Splitting
 * them would replay digits and letters as key presses, so they are kept whole.
 * Only the final bytes xterm actually emits count (CSI: arrows, Home/End, focus, mouse,
 * Shift+Tab, F1-F4, `~`; SS3: arrows, Home/End, F1-F4), so typed text such as `Ok` is not one.
 */
const ESCAPE_REMNANT = /^(?:\[[\d;<:?]*[A-DFHIMOPQRSZm~]|O[A-DFHPQRS])$/;
const PASTE_MARKERS = new Set(["[200~", "[201~"]);

/** Keys that did not arrive alone: split off a multi-character block, or read after another key in the same turn. */
const groupedKeys = new WeakSet<Key>();

/**
 * Whether this key press is a `y` that answers a confirmation. A `y` that arrived together with other
 * keys never does: they may have opened the question or moved the cursor to its end before it was drawn.
 * Text fields read `input` directly, so pasted text still reaches them.
 */
export function isYes(input: string, key: Key): boolean {
  return input === "y" && !groupedKeys.has(key);
}

function grouped(key: Key): Key {
  const copy = { ...key };
  groupedKeys.add(copy);
  return copy;
}

/**
 * The most events any hook has read this turn. A hook that mounts mid-read starts its own count at 0, but the hooks that were already
 * listening have counted the keys it missed, so this tells it that it is not at the start of the turn.
 */
let eventsInTurn = 0;

/**
 * `useInput` that treats several plain characters delivered in one write (fast
 * typing, a paste) as the separate key presses they are, in order. Ink also hands
 * the escape sequences of one read over as separate events within one turn; every key
 * after the first of a turn counts as grouped, in any hook, as do all characters of a split block.
 */
export function useKeys(handler: KeyHandler): void {
  const eventsThisTurn = useRef(0);
  useInput((input, key) => {
    if (eventsInTurn === 0) queueMicrotask(() => { eventsInTurn = 0; });
    if (eventsThisTurn.current++ === 0) queueMicrotask(() => { eventsThisTurn.current = 0; });
    eventsInTurn = Math.max(eventsInTurn, eventsThisTurn.current);
    const later = eventsThisTurn.current > 1 || eventsInTurn > 1;
    if (ESCAPE_REMNANT.test(input)) {
      if (!PASTE_MARKERS.has(input)) handler(input, later ? grouped(key) : key);
      return;
    }
    if (input.length > 1 && !key.ctrl && !key.meta && !key.escape && PRINTABLE.test(input)) {
      const blockKey = grouped(key);
      for (const character of input) handler(character, blockKey);
      return;
    }
    handler(input, later ? grouped(key) : key);
  });
}
