import { useInput, type Key } from "ink";

export type KeyHandler = (input: string, key: Key) => void;

/** Plain printable characters only: control characters and escape sequences are never split. */
const PRINTABLE = /^[^\p{Cc}]+$/u;

/**
 * `useInput` that treats several plain characters delivered in one write (fast
 * typing, a paste) as the separate key presses they are, in order.
 */
export function useKeys(handler: KeyHandler): void {
  useInput((input, key) => {
    if (input.length > 1 && !key.ctrl && !key.meta && !key.escape && PRINTABLE.test(input)) {
      for (const character of input) handler(character, key);
      return;
    }
    handler(input, key);
  });
}
