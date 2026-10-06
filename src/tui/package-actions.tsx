import type { Key } from "ink";

import { describeCoordinates, type PackageAction, type PackageLifecyclePlan, type PackageLifecycleResult, type PackageSelection } from "../package-model.js";
import type { PackageOperations } from "../package-flow.js";
import type { PackageApprovalStatus } from "../package-state.js";
import { errorText } from "./batch.js";
import type { ManageContext } from "./manage-actions.js";
import { answerYesNo } from "./mode-keys.js";
import { installedEvidenceLabel, packagePlanLines } from "./package-rows.js";
import { PreviewConfirm } from "./panel-parts.js";

/** A Package row the Installations view can act on. */
export interface PackageTarget {
  readonly selection: PackageSelection;
  readonly name: string;
}

/** The per-row keys of a Package; Enter is approval, handled beside these. */
export const PACKAGE_ACTION_KEYS: ReadonlyMap<string, PackageAction> = new Map([
  ["i", "install"],
  ["U", "update"],
  ["u", "uninstall"],
  ["f", "forget"],
]);

/** Package interaction modes capture keys inside the existing Installations view. */
export type PackageMode =
  | { readonly kind: "package-approve"; readonly target: PackageTarget; readonly lines: readonly string[] }
  | { readonly kind: "package-confirm"; readonly plan: PackageLifecyclePlan; readonly approval: PackageApprovalStatus }
  | { readonly kind: "package-forget"; readonly target: PackageTarget; readonly lines: readonly string[] };

export const PACKAGE_KINDS: readonly PackageMode["kind"][] = ["package-approve", "package-confirm", "package-forget"];

/** Narrows the view's mode without asserting a partial mode is a Package mode. */
export function isPackageMode(mode: { readonly kind: string }): mode is PackageMode {
  return PACKAGE_KINDS.some(kind => kind === mode.kind);
}

export interface PackageContext {
  readonly packages: PackageOperations;
  readonly manage: ManageContext;
}

/** `install`, `update`, `uninstall` and `forget` plan a step; `approve` writes the install receipt. */
export async function startPackageAction(context: PackageContext, target: PackageTarget, input: string): Promise<void> {
  const { manage, packages } = context;
  manage.setMessage(undefined);
  try {
    if (input === "approve") {
      manage.setMode({ kind: "busy", label: `Preparing the declaration of ${target.name}...` });
      const plan = await packages.planLifecycle(target.selection, "install");
      if (manage.isMounted()) {
        manage.setMode({ kind: "package-approve", target, lines: packagePlanLines(plan, "needs approval") });
      }
      return;
    }
    const action = PACKAGE_ACTION_KEYS.get(input);
    if (action === "forget") {
      manage.setMode({ kind: "busy", label: `Preparing to forget ${target.name}...` });
      const inspection = await packages.inspect(target.selection);
      if (manage.isMounted()) {
        manage.setMode({
          kind: "package-forget",
          target,
          lines: [
            `Package: ${target.name} (${target.selection.host})`,
            `Coordinates: ${describeCoordinates(target.selection)}`,
            `Installed: ${installedEvidenceLabel(inspection.installed)}`,
            "Forgetting drops the Agent Depot selection record only; the host install is left as it is and no host command runs.",
          ],
        });
      }
      return;
    }
    if (action !== undefined) {
      manage.setMode({ kind: "busy", label: `Preparing the ${action} of ${target.name}...` });
      const plan = await packages.planLifecycle(target.selection, action);
      const approval = await packages.approvalStatus(target.selection, action);
      if (manage.isMounted()) manage.setMode({ kind: "package-confirm", plan, approval });
      return;
    }
    await manage.finish({ kind: "error", text: `The action ${JSON.stringify(input)} is not available for Packages` });
  } catch (error) {
    await manage.finish({ kind: "error", text: errorText(error) });
  }
}

/** The `y` of a lifecycle confirmation whose receipt is missing approves it first, then asks again. */
async function approveThenConfirm(context: PackageContext, mode: Extract<PackageMode, { kind: "package-confirm" }>): Promise<void> {
  const { manage, packages } = context;
  manage.setMode({ kind: "busy", label: `Approving the ${mode.plan.action} declaration of ${mode.plan.descriptor.name}...` });
  try {
    await packages.approve(mode.plan.selection, mode.plan.action);
    if (manage.isMounted()) manage.setMode({ ...mode, approval: "approved" });
  } catch (error) {
    if (manage.isMounted()) await manage.finish({ kind: "error", text: errorText(error) });
  }
}

function resultLine(plan: PackageLifecyclePlan, result: PackageLifecycleResult): { readonly ok: boolean; readonly text: string } {
  const name = plan.descriptor.name;
  switch (result.status) {
    case "installed":
      return { ok: true, text: `${name}: installed (${installedEvidenceLabel(result.verified)})` };
    case "updated":
      return { ok: true, text: `${name}: updated (${installedEvidenceLabel(result.previous)} -> ${installedEvidenceLabel(result.verified)})` };
    case "removed":
      return { ok: true, text: `${name}: removed` };
    case "selected":
      return { ok: true, text: `${name}: selected` };
    case "forgotten":
      return { ok: true, text: `${name}: forgotten` };
    case "not confirmed":
      return { ok: true, text: `${name}: not changed` };
    case "stale plan":
      return { ok: false, text: `${name}: ${plan.action} not run: ${result.reason}` };
    case "manual required":
      return { ok: false, text: `${name}: ${plan.action} needs a manual step: ${result.reason}` };
    case "failed":
      return { ok: false, text: `${name}: failed: ${result.reason}${result.output === undefined ? "" : ` (${result.output})`}` };
  }
}

async function executePackagePlan(context: PackageContext, plan: PackageLifecyclePlan): Promise<void> {
  const { manage, packages } = context;
  manage.setMode({ kind: "busy", label: `Running the ${plan.action} of ${plan.descriptor.name}...` });
  let result: PackageLifecycleResult;
  try {
    result = await packages.executeLifecycle(plan, true);
  } catch (error) {
    await manage.finish({ kind: "error", text: errorText(error) });
    return;
  }
  const line = resultLine(plan, result);
  await manage.finish({ kind: line.ok ? "ok" : "error", text: line.text });
}

async function forgetSelection(context: PackageContext, mode: Extract<PackageMode, { kind: "package-forget" }>): Promise<void> {
  const { manage, packages } = context;
  manage.setMode({ kind: "busy", label: `Forgetting ${mode.target.name}...` });
  try {
    await packages.forget(mode.target.selection, true);
    await manage.finish({ kind: "ok", text: `Forgot ${mode.target.name}; no host command ran` });
  } catch (error) {
    await manage.finish({ kind: "error", text: errorText(error) });
  }
}

/** Applies the y/n keys of every Package confirmation; `n` and Esc run nothing. */
export function handlePackageKey(context: PackageContext, mode: PackageMode, input: string, key: Key): void {
  const { manage, packages } = context;
  const cancel = (text: string) => {
    manage.setMessage({ kind: "ok", text });
    manage.browse();
  };
  switch (mode.kind) {
    case "package-approve":
      answerYesNo(input, key, () => {
        manage.setMode({ kind: "busy", label: `Approving the install declaration of ${mode.target.name}...` });
        void packages.approve(mode.target.selection, "install").then(
          () => manage.finish({ kind: "ok", text: `Approved the install declaration of ${mode.target.name}` }),
          error => manage.finish({ kind: "error", text: errorText(error) }),
        );
      }, () => cancel("Package action cancelled"));
      return;
    case "package-forget":
      answerYesNo(input, key, () => void forgetSelection(context, mode), () => cancel("Package action cancelled"));
      return;
    case "package-confirm":
      answerYesNo(input, key, () => {
        if (mode.approval === "needs approval") void approveThenConfirm(context, mode);
        else void executePackagePlan(context, mode.plan);
      }, () => cancel("Package action cancelled"));
      return;
  }
}

/** Renders a Package prompt with the existing preview panel and y/n confirmation. */
export function PackagePanel({ mode }: { readonly mode: PackageMode }) {
  switch (mode.kind) {
    case "package-approve":
      return <PreviewConfirm lines={mode.lines} question={`Approve this install declaration for ${mode.target.name}? y/n`} />;
    case "package-forget":
      return <PreviewConfirm lines={mode.lines} question={`Forget the selection record of ${mode.target.name}? y/n`} />;
    case "package-confirm":
      return (
        <PreviewConfirm
          lines={packagePlanLines(mode.plan, mode.approval)}
          question={mode.approval === "needs approval"
            ? "Approve this declaration and continue? y/n"
            : `${mode.plan.action} ${mode.plan.descriptor.name}? y/n`}
        />
      );
  }
}
