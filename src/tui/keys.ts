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
      for (const character of input) handler(character, key);
      return;
    }
    handler(input, key);
  });
}
