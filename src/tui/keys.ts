import { useInput, type Key } from "ink";

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

/** Keys that were split off a multi-character block (fast typing, a paste). */
const blockKeys = new WeakSet<Key>();

/**
 * Whether this key press is a `y` that answers a confirmation. A `y` that came in a block with other
 * characters never does: the block may have opened the question itself, before it was drawn.
 * Text fields read `input` directly, so pasted text still reaches them.
 */
export function isYes(input: string, key: Key): boolean {
  return input === "y" && !blockKeys.has(key);
}

/**
 * `useInput` that treats several plain characters delivered in one write (fast
 * typing, a paste) as the separate key presses they are, in order.
 */
export function useKeys(handler: KeyHandler): void {
  useInput((input, key) => {
    if (ESCAPE_REMNANT.test(input)) {
      if (!PASTE_MARKERS.has(input)) handler(input, key);
      return;
    }
    if (input.length > 1 && !key.ctrl && !key.meta && !key.escape && PRINTABLE.test(input)) {
      const blockKey = { ...key };
      blockKeys.add(blockKey);
      for (const character of input) handler(character, blockKey);
      return;
    }
    handler(input, key);
  });
}
