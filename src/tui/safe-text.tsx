import { Text as InkText } from "ink";
import { cloneElement, Fragment, isValidElement, type ComponentProps, type ReactNode } from "react";

import { escapeControlText } from "./preview-window.js";

/** Ink's `Text` for text that was already passed through `escapeControlText`; escaping it again would double its backslashes. */
export const PreEscapedText = InkText;

// Messages and errors span lines on purpose and Ink lays them out, so a line break is the one control character left alone.
const LINE_BREAK = /\r?\n/u;

function escapeNode(node: ReactNode): ReactNode {
  if (typeof node === "string") return node.split(LINE_BREAK).map(escapeControlText).join("\n");
  if (Array.isArray(node)) return node.map(escapeNode);
  if (isValidElement<{ readonly children?: ReactNode }>(node) && node.type === Fragment) {
    return cloneElement(node, undefined, escapeNode(node.props.children));
  }
  return node;
}

/**
 * The `Text` every view uses. Skill, recipe and App text can come from a remote Source or a user-written recipe; raw, an ESC
 * sequence in it can retitle the window, write the clipboard or redraw the screen. Nested `Text` escapes its own children.
 */
export function Text({ children, ...props }: ComponentProps<typeof InkText>) {
  return <InkText {...props}>{escapeNode(children)}</InkText>;
}
