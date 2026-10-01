import { Box, Text, type Key } from "ink";

import type { AppEntry, AppLifecyclePlan, AppOperations } from "../app-flow.js";
import { PROJECT_HOSTS, type ProjectHost } from "../project-manifest.js";
import { errorText, runBatch } from "./batch.js";
import type { ManageContext } from "./manage-actions.js";
import { answerYesNo, hostChecklistKey } from "./mode-keys.js";
import { HostChecklist, PreviewConfirm } from "./panel-parts.js";

interface Request {
  readonly entry: AppEntry;
  readonly action: AppLifecyclePlan["action"];
  readonly host?: ProjectHost;
}

/** App interaction modes capture keys inside the existing Installations view. */
export type AppMode =
  | { readonly kind: "app-approve"; readonly entry: AppEntry; readonly lines: readonly string[] }
  | {
      readonly kind: "app-hosts";
      readonly entries: readonly AppEntry[];
      readonly choices: readonly ProjectHost[];
      readonly cursor: number;
      readonly selected: readonly ProjectHost[];
    }
  | {
      readonly kind: "app-confirm" | "app-manual";
      readonly plan: AppLifecyclePlan;
      readonly remaining: readonly Request[];
      readonly results: readonly string[];
      readonly failures: number;
    };

export const APP_KINDS: readonly AppMode["kind"][] = ["app-approve", "app-hosts", "app-confirm", "app-manual"];

/** Narrows the view's mode without asserting a partial mode is an App mode. */
export function isAppMode(mode: { readonly kind: string }): mode is AppMode {
  return APP_KINDS.some(kind => kind === mode.kind);
}

export interface AppContext {
  readonly apps: AppOperations;
  readonly manage: ManageContext;
}

/** Recipe name, falling back to the file identity for invalid recipes. */
export const appName = (entry: AppEntry) => entry.recipe?.name ?? entry.file;

export function appStepLines(step: {
  readonly argv?: readonly string[];
  readonly manual?: string;
  readonly executable?: string;
  readonly cwd: string;
  readonly warning?: string;
}): string[] {
  return [
    ...(step.argv ? [`argv: ${JSON.stringify(step.argv)}`, `Executable: ${step.executable ?? "unavailable"}`] : []),
    ...(step.manual ? [`Manual: ${step.manual}`] : []),
    `Working directory: ${step.cwd}`,
    ...(step.warning ? [step.warning] : []),
  ];
}

async function prepareNext(
  context: AppContext,
  requests: readonly Request[],
  results: readonly string[] = [],
  failures = 0,
): Promise<void> {
  const { manage, apps } = context;
  manage.setMode({ kind: "busy", label: "Preparing App step..." });
  // Independent planning failures never stop the remaining marked Apps.
  const [request, ...remaining] = requests;
  if (!request) {
    await manage.finish({ kind: failures > 0 ? "error" : "ok", text: results.join("\n") });
    return;
  }
  try {
    const plan = await apps.planLifecycle(request.entry, request.action, request.host);
    if (manage.isMounted()) {
      manage.setMode({
        kind: !plan.argv && plan.manual ? "app-manual" : "app-confirm",
        plan, remaining, results, failures,
      });
    }
  } catch (error) {
    if (manage.isMounted()) {
      await prepareNext(context, remaining, [...results, `${appName(request.entry)}: failed: ${errorText(error)}`], failures + 1);
    }
  }
}

/** Opens approval, the Host checklist, or the first lifecycle preview for selected Apps. */
export async function startAppAction(context: AppContext, entries: readonly AppEntry[], input: string): Promise<void> {
  const { manage, apps } = context;
  manage.setMessage(undefined);
  try {
    if (input === "approve") {
      const entry = entries[0];
      if (!entry) throw new Error("No App selected");
      manage.setMode({ kind: "busy", label: "Preparing recipe approval..." });
      const steps = await apps.preview(entry);
      if (manage.isMounted()) {
        manage.setMode({ kind: "app-approve", entry, lines: steps.flatMap(step => [step.step, ...appStepLines(step)]) });
      }
    } else if (input === "h") {
      const choices = PROJECT_HOSTS.filter(host => entries.some(entry => entry.recipe?.setup?.[host] || entry.recipe?.teardown?.[host]));
      if (!choices.length) throw new Error("No declared Host steps");
      // This is an action selector, not a claim about persisted Host wiring.
      manage.setMode({
        kind: "app-hosts", entries, choices, cursor: 0,
        selected: choices.filter(host => entries.some(entry => entry.recipe?.teardown?.[host])),
      });
    } else {
      await prepareNext(context, entries.map(entry => ({ entry, action: input === "u" ? "uninstall" : "install" })));
    }
  } catch (error) {
    await manage.finish({ kind: "error", text: errorText(error) });
  }
}

async function execute(context: AppContext, mode: Extract<AppMode, { kind: "app-confirm" | "app-manual" }>): Promise<void> {
  const { manage, apps } = context;
  manage.setMode({ kind: "busy", label: "Running App step..." });
  let manualRequired = false;
  const [outcome] = await runBatch([mode.plan], async plan => {
    const result = mode.kind === "app-manual"
      ? await apps.completeManual(plan, true)
      : await apps.executeLifecycle(plan, true);
    if (result.status === "manual required") {
      manualRequired = true;
      if (manage.isMounted()) manage.setMode({ ...mode, kind: "app-manual" });
      return "manual required";
    }
    if (result.status === "failed") throw new Error(result.reason);
    manage.unmark([`app:${plan.entry.file}`]);
    return `${appName(plan.entry)}: ${result.status}${result.installedVersion ? ` ${result.installedVersion}` : ""}`;
  }, (plan, error) => `${appName(plan.entry)}: failed: ${errorText(error)}`);
  if (manage.isMounted() && outcome && !manualRequired) {
    await prepareNext(context, mode.remaining, [...mode.results, outcome.line], mode.failures + (outcome.ok ? 0 : 1));
  }
}

/** Applies checklist and y/n keys, continuing independent batch steps after cancellation or failure. */
export function handleAppKey(context: AppContext, mode: AppMode, input: string, key: Key): void {
  const { manage, apps } = context;
  const cancel = () => {
    manage.browse();
    manage.setMessage({ kind: "ok", text: "App action cancelled" });
  };
  if (mode.kind === "app-hosts") {
    const outcome = hostChecklistKey(mode, mode.choices, input, key);
    if (outcome.kind === "cancel") cancel();
    else if (outcome.kind === "update") manage.setMode({ ...mode, ...outcome.state });
    else if (key.return) {
      const requests = mode.entries.flatMap(entry => mode.choices.flatMap(host => {
        const action = mode.selected.includes(host) ? "setup" as const : "teardown" as const;
        return entry.recipe?.[action]?.[host] ? [{ entry, action, host }] : [];
      }));
      if (!requests.length) manage.setMessage({ kind: "error", text: "No declared steps for this selection" });
      else void prepareNext(context, requests);
    }
  } else answerYesNo(input, key, () => {
    if (mode.kind !== "app-approve") {
      void execute(context, mode);
      return;
    }
    manage.setMode({ kind: "busy", label: "Approving recipe..." });
    void apps.approve(mode.entry).then(
      () => manage.finish({ kind: "ok", text: `Approved ${appName(mode.entry)}` }),
      error => manage.finish({ kind: "error", text: errorText(error) }),
    );
  }, () => {
    if (mode.kind === "app-confirm" || mode.kind === "app-manual") {
      void prepareNext(context, mode.remaining, [...mode.results, `${appName(mode.plan.entry)}: cancelled`], mode.failures);
    } else cancel();
  });
}

/** Renders App prompts using the existing checklist and preview-confirm panels. */
export function AppPanel({ mode }: { readonly mode: AppMode }) {
  if (mode.kind === "app-hosts") {
    return (
      <Box flexDirection="column">
        <Text>
          App Host steps: checked = setup, unchecked = teardown. Wiring is not tracked.
          Space/1-{mode.choices.length} toggle, j/k move, Enter continue, Esc cancel.
        </Text>
        <HostChecklist choices={mode.choices} cursor={mode.cursor} selected={mode.selected} />
      </Box>
    );
  }
  if (mode.kind === "app-approve") {
    return <PreviewConfirm lines={mode.lines} question={`Approve ${appName(mode.entry)}? y/n`} />;
  }
  return (
    <PreviewConfirm
      lines={[
        `Environment: ${mode.plan.environment}`,
        `App: ${appName(mode.plan.entry)} ${mode.plan.action}${mode.plan.host ? ` (${mode.plan.host})` : ""}`,
        ...appStepLines(mode.plan),
      ]}
      question={mode.kind === "app-manual"
        ? "Manual step done, check now? y/n"
        : `${mode.plan.action} ${appName(mode.plan.entry)}? y/n`}
    />
  );
}
