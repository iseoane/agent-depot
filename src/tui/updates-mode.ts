import type { AppLifecyclePlan } from "../app-flow.js";
import type { PreparedUpdates } from "./updates.js";

/** Interaction mode of the Updates view; anything but `browse` captures keys so global keys such as q are suspended. */
export type UpdatesMode =
  | { readonly kind: "browse" }
  | { readonly kind: "manual"; readonly plan: AppLifecyclePlan; readonly reason: string | undefined; readonly answer: (done: boolean) => void }
  | { readonly kind: "busy"; readonly label: string }
  | { readonly kind: "preview"; readonly prepared: PreparedUpdates }
  | { readonly kind: "confirm-paths"; readonly prepared: PreparedUpdates };

export const BROWSE: UpdatesMode = { kind: "browse" };
