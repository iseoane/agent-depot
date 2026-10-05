import type { GitSource } from "../git-source.js";

/** Interaction mode of the Sources view; only `browse` lets global keys such as q act. */
export type Mode =
  | { readonly kind: "browse" }
  | { readonly kind: "add-kind" }
  | { readonly kind: "input"; readonly value: string }
  | { readonly kind: "confirm"; readonly action: "refresh"; readonly sources: readonly GitSource[] }
  | { readonly kind: "confirm"; readonly action: "remove"; readonly source: GitSource }
  | { readonly kind: "busy" };

export type ModeEvent =
  | { readonly type: "add-kind" }
  | { readonly type: "input" }
  | { readonly type: "edit"; readonly value: string }
  | { readonly type: "confirm"; readonly action: "refresh"; readonly sources: readonly GitSource[] }
  | { readonly type: "confirm"; readonly action: "remove"; readonly source: GitSource }
  | { readonly type: "busy" }
  | { readonly type: "done" };

export const initialMode: Mode = { kind: "browse" };

export function modeReducer(mode: Mode, event: ModeEvent): Mode {
  switch (event.type) {
    case "add-kind":
      return { kind: "add-kind" };
    case "input":
      return { kind: "input", value: "" };
    case "edit":
      return mode.kind === "input" ? { kind: "input", value: event.value } : mode;
    case "confirm":
      return event.action === "refresh"
        ? { kind: "confirm", action: "refresh", sources: event.sources }
        : { kind: "confirm", action: "remove", source: event.source };
    case "busy":
      return { kind: "busy" };
    case "done":
      return initialMode;
  }
}
