import type { UpdateBatchAssessmentItem } from "../update-batch.js";
import type { PreparedUpdates } from "./updates.js";

/** Interaction mode of the Updates view; anything but `browse` captures keys so global keys such as q are suspended. */
export type UpdatesMode =
  | { readonly kind: "browse" }
  | { readonly kind: "busy"; readonly label: string }
  | { readonly kind: "preview"; readonly selected: readonly UpdateBatchAssessmentItem[]; readonly prepared: PreparedUpdates }
  | { readonly kind: "confirm-paths"; readonly selected: readonly UpdateBatchAssessmentItem[]; readonly prepared: PreparedUpdates };

export const BROWSE: UpdatesMode = { kind: "browse" };
