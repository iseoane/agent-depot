import type { Source } from "../sources.js";

/** Interaction mode of the Sources view; only `browse` lets global keys such as q act. */
export type Mode =
  | { readonly kind: "browse" }
  | { readonly kind: "input"; readonly value: string }
  | { readonly kind: "confirm"; readonly action: "refresh" | "remove"; readonly source: Source }
  | { readonly kind: "busy" };

export type ModeEvent =
  | { readonly type: "input" }
  | { readonly type: "edit"; readonly value: string }
  | { readonly type: "confirm"; readonly action: "refresh" | "remove"; readonly source: Source }
  | { readonly type: "busy" }
  | { readonly type: "done" };

export const initialMode: Mode = { kind: "browse" };

export function modeReducer(mode: Mode, event: ModeEvent): Mode {
  switch (event.type) {
    case "input":
      return { kind: "input", value: "" };
    case "edit":
      return mode.kind === "input" ? { kind: "input", value: event.value } : mode;
    case "confirm":
      return { kind: "confirm", action: event.action, source: event.source };
    case "busy":
      return { kind: "busy" };
    case "done":
      return initialMode;
  }
}
