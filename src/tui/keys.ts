import { useLayoutEffect } from "react";
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

/** Paged previews currently on screen, counted by `useOpenPreview`. */
let openPreviews = 0;

/**
 * Marks a paged preview as open while the calling component is mounted. Handlers read refs that
 * update synchronously, so a `y` split off a block that also moved the cursor would confirm before
 * the footer could show `read ✓`.
 */
export function useOpenPreview(): void {
  // Layout, not passive: the count must be current as soon as the frame is on screen.
  useLayoutEffect(() => {
    openPreviews += 1;
    return () => { openPreviews -= 1; };
  }, []);
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
      // A confirmation must be its own key press after the footer shows `read ✓`.
      for (const character of input) {
        if (openPreviews > 0 && (character === "y" || character === "Y")) continue;
        handler(character, key);
      }
      return;
    }
    handler(input, key);
  });
}
