import { type Key } from "ink";
import { Text } from "./safe-text.js";

import type { AppEntry, AppLifecyclePlan, AppOperations } from "../app-flow.js";
import { commandLine } from "../preview-model.js";
import { PROJECT_HOSTS, type ProjectHost } from "../project-manifest.js";
import { errorText, runBatch } from "./batch.js";
import type { ManageContext } from "./manage-actions.js";
import { isYes } from "./keys.js";
import { hostChecklistKey, movePreviewCursor } from "./mode-keys.js";
import { BorderPanel, HostChecklist, PagedPreview, Working } from "./panel-parts.js";
import { usePreviewGeometry, type PreviewChrome, type PreviewGeometry } from "./preview-window.js";
import { fieldLine, lineText, span, stepBlockLines, textLine, type StepPreview, type StyledLine } from "./preview-render.js";
import { theme } from "./theme.js";
import { operationStart } from "./working-model.js";

/** Finished items shown under a running batch; older ones are counted. */
const MAX_DONE_LINES = 3;

interface Request {
  readonly entry: AppEntry;
  readonly action: AppLifecyclePlan["action"];
  readonly host?: ProjectHost;
}

/** App interaction modes capture keys inside the existing Installations view. */
export type AppMode =
  | {
      readonly kind: "app-busy";
      readonly label: string;
      readonly startedAt: number;
      /** Result lines of the batch items finished so far. */
      readonly done?: readonly string[];
    }
  | { readonly kind: "app-approve"; readonly entry: AppEntry; readonly lines: readonly StyledLine[]; readonly cursor: number }
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
      readonly cursor: number;
    };

export const APP_KINDS: readonly AppMode["kind"][] = ["app-busy", "app-approve", "app-hosts", "app-confirm", "app-manual"];

/** Narrows the view's mode without asserting a partial mode is an App mode. */
export function isAppMode(mode: { readonly kind: string }): mode is AppMode {
  return APP_KINDS.some(kind => kind === mode.kind);
}

export type AppActionHost = Pick<ManageContext, "browse" | "setMessage" | "isMounted" | "finish" | "unmark">
  & { setMode(mode: AppMode): void };

export interface AppContext {
  readonly apps: AppOperations;
  readonly manage: AppActionHost;
  readonly previewGeometry: PreviewGeometry;
}

/** Recipe name, falling back to the file identity for invalid recipes. */
export const appName = (entry: AppEntry) => entry.recipe?.name ?? entry.file;

function appPreviewChrome(mode: Extract<AppMode, { kind: "app-approve" | "app-confirm" | "app-manual" }>): PreviewChrome {
  if (mode.kind === "app-approve") return recipeApprovalChrome(mode.entry);
  if (mode.kind === "app-manual") return { title: "App manual step", action: "Check now", consequence: "Manual step done, check now? y/n" };
  const { action, entry } = mode.plan;
  return {
    title: `App ${action} confirmation`,
    action: `${action[0]!.toUpperCase()}${action.slice(1)} ${appName(entry)}`,
    consequence: `${action} ${appName(entry)}? y/n`,
  };
}

/** Approving a recipe records consent to its commands; it installs nothing. */
export function recipeApprovalChrome(entry: AppEntry): PreviewChrome {
  return {
    title: "Recipe approval · does not install",
    action: `Approve ${appName(entry)}`,
    consequence: `Approve ${appName(entry)}? y/n · recipe approval does not install the App.`,
  };
}

/** What confirming an App step does: its name, Host and versions, then the step as one block. */
export function appPlanLines(plan: AppLifecyclePlan): readonly StyledLine[] {
  const { previousVersion, latestVersion } = plan;
  const both = previousVersion !== undefined && latestVersion !== undefined;
  return [
    [
      span(` App ${appName(plan.entry)} ${plan.action}${plan.host ? ` (${plan.host})` : ""}`, theme.value, true),
      ...(both ? [span(`  ${previousVersion} → ${latestVersion}`, theme.version)] : []),
    ],
    ...(!both && previousVersion !== undefined ? [fieldLine(" Previous version:", previousVersion)] : []),
    ...(!both && latestVersion !== undefined ? [fieldLine(" Latest version:", latestVersion)] : []),
    textLine(" "),
    ...stepBlockLines([{ ...plan, step: plan.host ? `${plan.action}.${plan.host}` : plan.action }]),
  ];
}

/** The recipe's identity and approval status, then one block per step. */
export function appRecipePreviewLines(entry: AppEntry, status: string, steps: readonly StepPreview[]): readonly StyledLine[] {
  const recipe = entry.recipe;
  return [
    [
      span(` ${appName(entry)}`, theme.value, true),
      span(`  ${recipe?.platform ?? "all"}`, theme.field),
      span(`  ● ${status}`, status === "approved" ? theme.success : theme.warning),
    ],
    [span(` ${[entry.file, ...(recipe?.homepage ? [recipe.homepage] : [])].join(" · ")}`, theme.legend)],
    ...(recipe?.skills ? [fieldLine(" Owned Skills:", commandLine(recipe.skills))] : []),
    textLine(" "),
    ...stepBlockLines(steps),
  ];
}

function appPreviewLines(mode: Extract<AppMode, { kind: "app-approve" | "app-confirm" | "app-manual" }>): readonly StyledLine[] {
  return mode.kind === "app-approve" ? mode.lines : appPlanLines(mode.plan);
}

/** The busy mode of an App step; `previous` is the busy mode this step continues, so the clock keeps running. */
function appBusy(label: string, previous?: AppMode, done?: readonly string[]): AppMode {
  return { kind: "app-busy", label, startedAt: operationStart(previous), ...(done?.length ? { done } : {}) };
}

/** `Running App step: name (2/5)…`; the position is left out for a batch of one. */
function stepLabel(verb: string, entry: AppEntry, finished: number, total: number): string {
  return `${verb} App step: ${appName(entry)}${total > 1 ? ` (${finished + 1}/${total})` : ""}…`;
}

async function prepareNext(
  context: AppContext,
  requests: readonly Request[],
  results: readonly string[] = [],
  failures = 0,
  previous?: AppMode,
): Promise<void> {
  const { manage, apps } = context;
  // Independent planning failures never stop the remaining marked Apps.
  const [request, ...remaining] = requests;
  const running = appBusy(
    request ? stepLabel("Preparing", request.entry, results.length, results.length + requests.length) : "Finishing App steps…",
    previous,
    // Once the batch is over its results are the Result panel, not a busy line.
    request ? results : undefined,
  );
  manage.setMode(running);
  if (!request) {
    await manage.finish({ kind: failures > 0 ? "error" : "ok", text: results.join("\n") });
    return;
  }
  try {
    const plan = await apps.planLifecycle(request.entry, request.action, request.host);
    if (manage.isMounted()) {
      manage.setMode({
        kind: !plan.argv && plan.manual ? "app-manual" : "app-confirm",
        plan, remaining, results, failures, cursor: 0,
      });
    }
  } catch (error) {
    if (manage.isMounted()) {
      await prepareNext(context, remaining, [...results, `${appName(request.entry)}: failed: ${errorText(error)}`], failures + 1, running);
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
      manage.setMode(appBusy("Preparing recipe approval…"));
      const [steps, approval] = await Promise.all([apps.preview(entry), apps.approvalStatus(entry)]);
      if (manage.isMounted()) {
        manage.setMode({ kind: "app-approve", entry, lines: appRecipePreviewLines(entry, approval.status, steps), cursor: 0 });
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
  const running = appBusy(
    stepLabel("Running", mode.plan.entry, mode.results.length, mode.results.length + 1 + mode.remaining.length),
    undefined,
    mode.results,
  );
  manage.setMode(running);
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
    await prepareNext(context, mode.remaining, [...mode.results, outcome.line], mode.failures + (outcome.ok ? 0 : 1), running);
  }
}

/** Applies checklist and y/n keys, continuing independent batch steps after cancellation or failure. */
export function handleAppKey(context: AppContext, mode: AppMode, input: string, key: Key): void {
  const { manage, apps } = context;
  if (mode.kind === "app-busy") return;
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
  } else {
    const lines = appPreviewLines(mode).map(lineText);
    const viewport = context.previewGeometry(lines, mode.cursor, appPreviewChrome(mode));
    const cursor = movePreviewCursor(mode.cursor, viewport.total, input, key, viewport.height);
    if (cursor !== undefined) {
      manage.setMode({ ...mode, cursor });
      return;
    }
    if (input === "n" || key.escape) {
      if (mode.kind === "app-confirm" || mode.kind === "app-manual") {
        void prepareNext(context, mode.remaining, [...mode.results, `${appName(mode.plan.entry)}: cancelled`], mode.failures);
      } else cancel();
      return;
    }
    if (!isYes(input, key) || !viewport.reachedEnd) return;
    if (mode.kind !== "app-approve") {
      void execute(context, mode);
      return;
    }
    manage.setMode(appBusy("Approving recipe…"));
    void apps.approve(mode.entry).then(
      () => manage.finish({ kind: "ok", text: `Approved ${appName(mode.entry)}` }),
      error => manage.finish({ kind: "error", text: errorText(error) }),
    );
  }
}

/** Renders App prompts using the existing checklist and preview-confirm panels. */
export function AppPanel({ mode }: { readonly mode: AppMode }) {
  const geometry = usePreviewGeometry();
  if (mode.kind === "app-busy") {
    const done = mode.done ?? [];
    return (
      <BorderPanel title="App lifecycle">
        <Working label={mode.label} since={mode.startedAt} />
        {done.length > MAX_DONE_LINES ? <Text color={theme.muted}>{done.length - MAX_DONE_LINES} earlier finished</Text> : null}
        {done.slice(-MAX_DONE_LINES).map((line, index) => <Text key={index} color={theme.muted}>{line}</Text>)}
      </BorderPanel>
    );
  }
  if (mode.kind === "app-hosts") {
    return (
      <BorderPanel title="App Host steps">
        <Text>Checked = setup. Unchecked = teardown. Wiring is not tracked.</Text>
        <Text>Space/1-{mode.choices.length} toggle · j/k move · Enter continue · Esc cancel</Text>
        <HostChecklist choices={mode.choices} cursor={mode.cursor} selected={mode.selected} />
      </BorderPanel>
    );
  }
  const styled = appPreviewLines(mode);
  const lines = styled.map(lineText);
  const chrome = appPreviewChrome(mode);
  return <PagedPreview chrome={chrome} lines={lines} styled={styled} viewport={geometry(lines, mode.cursor, chrome)} />;
}
