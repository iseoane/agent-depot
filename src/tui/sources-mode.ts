import type { GitSource } from "../git-source.js";
import { busy, type Busy } from "./working-model.js";

/** Interaction mode of the Sources view; only `browse` lets global keys such as q act. */
export type Mode =
  | { readonly kind: "browse" }
  | { readonly kind: "add-kind" }
  | { readonly kind: "input"; readonly value: string }
  | { readonly kind: "confirm"; readonly action: "refresh"; readonly sources: readonly GitSource[]; readonly cursor: number }
  | { readonly kind: "confirm"; readonly action: "remove"; readonly source: GitSource }
  | Busy;

export type ModeEvent =
  | { readonly type: "add-kind" }
  | { readonly type: "input" }
  | { readonly type: "edit"; readonly value: string }
  | { readonly type: "confirm"; readonly action: "refresh"; readonly sources: readonly GitSource[] }
  | { readonly type: "preview-cursor"; readonly cursor: number }
  | { readonly type: "confirm"; readonly action: "remove"; readonly source: GitSource }
  /** `startedAt` is read by the dispatcher, so the reducer stays pure; a busy mode already running keeps its own. */
  | { readonly type: "busy"; readonly label: string; readonly startedAt: number }
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
        ? { kind: "confirm", action: "refresh", sources: event.sources, cursor: 0 }
        : { kind: "confirm", action: "remove", source: event.source };
    case "preview-cursor":
      return mode.kind === "confirm" && mode.action === "refresh" ? { ...mode, cursor: event.cursor } : mode;
    case "busy":
      return busy(event.label, mode, () => event.startedAt);
    case "done":
      return initialMode;
  }
}
