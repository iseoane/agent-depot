import { sourceIdForUrl } from "./git-source.js";
import { PACKAGE_HOSTS, bundleRoot, describeCoordinates, selectionKey, type BundleDescriptor, type InstalledBundleEvidence, type InstalledPackage, type PackageAction, type PackageComponent, type PackageComponentEffect, type PackageCoordinates, type PackageHost, type PackageInspection, type PackageLifecyclePlan, type PackageLifecycleResult, type PackageSelection, type PackageUpdateCheck, type PackageVersionEvidence } from "./package-model.js";
import type { PackageOperations } from "./package-flow.js";
import type { ProjectSource } from "./project-manifest.js";
import type { Source, SourceOperations } from "./sources.js";
import { CliUsageError } from "./usage-error.js";

export const PACKAGE_USAGE = "Usage: agent-depot package list; package discover <source-id>; package inspect <selection> --host <host>; package approve <selection> --host <host> [--action <install|update|uninstall>]; package install|update|uninstall <selection> --host <host> [--yes]; package forget <selection> --host <host> --yes";

interface SelectionArgs {
  readonly selection: string;
  readonly host?: PackageHost;
  readonly confirmed: boolean;
  readonly approvalAction?: PackageAction;
}

interface SelectionArgsOptions {
  readonly allowConfirmation: boolean;
  readonly allowApprovalAction?: boolean;
}

interface SelectionToken {
  readonly sourceToken: string;
  readonly host?: PackageHost;
  readonly root: string;
  readonly pluginName?: string;
}

interface ResolvedSource {
  readonly source: Source;
  readonly projectSource: ProjectSource;
}

export async function runPackageCommand(
  values: readonly string[],
  packages: PackageOperations,
  sources: SourceOperations,
  output: (line: string) => void,
): Promise<number> {
  const [command, ...args] = values;
  if (command === "list") {
    requireNoArgs(args, "package list");
    for (const record of await packages.list()) {
      output(formatPackageRecord(record));
    }
    return 0;
  }
  if (command === "discover") {
    if (args.length !== 1 || args[0]!.startsWith("--")) {
      throw new CliUsageError(PACKAGE_USAGE);
    }
    const sourceId = args[0]!;
    for (const descriptor of await packages.discover([sourceId])) {
      output(`Package ${formatDescriptorSelection(sourceId, descriptor)}: ${descriptor.name}`);
      describeDescriptor(descriptor, output, "  ");
    }
    return 0;
  }
  if (command === "inspect") {
    const selection = await resolveSelection(parseSelectionArgs(args, { allowConfirmation: false }), packages, sources);
    describeInspection(selection, await packages.inspect(selection), output);
    return 0;
  }
  if (command === "approve") {
    const parsed = parseSelectionArgs(args, { allowConfirmation: false, allowApprovalAction: true });
    const action = parsed.approvalAction ?? "install";
    if (action === "select" || action === "forget") {
      throw new CliUsageError("Package approval only applies to install, update, and uninstall actions");
    }
    const selection = await resolveSelection(parsed, packages, sources);
    const plan = await packages.planLifecycle(selection, action);
    describeLifecyclePlan(plan, await packages.approvalStatus(selection, action), output);
    await packages.approve(selection, action);
    output(`Approved Package ${action}: ${formatPackageSelection(selection)}`);
    return 0;
  }
  if (command === "install" || command === "update" || command === "uninstall") {
    const parsed = parseSelectionArgs(args, { allowConfirmation: true });
    const selection = await resolveSelection(parsed, packages, sources);
    const plan = await packages.planLifecycle(selection, command);
    const approval = await packages.approvalStatus(selection, command);
    describeLifecyclePlan(plan, approval, output);
    if (approval !== "approved") {
      throw new Error(`Package ${command} needs approval; run package approve ${formatPackageSelection(selection)} --host ${selection.host} --action ${command} after reviewing the preview`);
    }
    if (!parsed.confirmed) {
      throw new Error(`Package ${command} not confirmed; rerun with --yes after reviewing the preview`);
    }
    const result = await packages.executeLifecycle(plan, true);
    output(`Package ${formatPackageSelection(selection)}: ${describePackageResult(result)}`);
    return packageResultSucceeded(result) ? 0 : 1;
  }
  if (command === "forget") {
    const parsed = parseSelectionArgs(args, { allowConfirmation: true });
    const selection = await resolveSelection(parsed, packages, sources, true);
    output(`Package forget preview: ${formatPackageSelection(selection)}`);
    output("  Host commands: none; only Agent Depot's Package selection record is removed");
    if (!parsed.confirmed) {
      throw new Error("Package forget not confirmed; rerun with --yes after reviewing the preview");
    }
    await packages.forget(selection, true);
    output(`Forgot Package: ${formatPackageSelection(selection)}`);
    return 0;
  }
  throw new CliUsageError(PACKAGE_USAGE);
}

export function formatPackageSelection(selection: PackageSelection): string {
  return `${sourceToken(selection.source)}::${describeSelectionCoordinate(selection)}`;
}

/**
 * The two spellings the CLI prints name the same selection: `discover` prints
 * the registered Source id, and `list` prints the Source's own token. Both are
 * accepted wherever a selection is taken as input.
 */
export function packageSelectionMatches(selection: PackageSelection, value: string): boolean {
  return formatPackageSelection(selection) === value
    || selectionKey(selection) === value
    || `${sourceIdToken(selection.source)}::${describeSelectionCoordinate(selection)}` === value;
}

export function describePackageUpdateCheck(check: PackageUpdateCheck): string {
  const available = check.available === undefined ? "unknown" : describeVersion(check.available);
  const reason = check.reason === undefined ? "" : `; ${check.reason}`;
  return `Package ${formatPackageSelection(check.installed.selection)}: ${check.status}; available ${available}${reason}`;
}

export function describePackageResult(result: PackageLifecycleResult): string {
  switch (result.status) {
    case "installed":
      return `installed (${describeEvidence(result.verified)})`;
    case "updated":
      return `updated (${describeEvidence(result.previous)} -> ${describeEvidence(result.verified)})`;
    case "removed":
    case "selected":
    case "forgotten":
    case "not confirmed":
      return result.status;
    case "stale plan":
    case "manual required":
    case "failed":
      return `${result.status}: ${result.reason}${"output" in result && result.output ? `; ${result.output}` : ""}`;
  }
}

function requireNoArgs(args: readonly string[], usage: string): void {
  if (args.length !== 0) {
    throw new CliUsageError(`Usage: agent-depot ${usage}`);
  }
}

function parseSelectionArgs(args: readonly string[], options: SelectionArgsOptions): SelectionArgs {
  let selection: string | undefined;
  let host: PackageHost | undefined;
  let confirmed = false;
  let approvalAction: PackageAction | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--yes") {
      if (!options.allowConfirmation) {
        throw new CliUsageError(PACKAGE_USAGE);
      }
      confirmed = true;
      continue;
    }
    if (argument === "--host") {
      host = parseHost(requireOptionValue(args, ++index, "--host"));
      continue;
    }
    if (argument === "--action" && options.allowApprovalAction === true) {
      approvalAction = parseApprovalAction(requireOptionValue(args, ++index, "--action"));
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliUsageError(PACKAGE_USAGE);
    }
    if (selection !== undefined) {
      throw new CliUsageError(PACKAGE_USAGE);
    }
    selection = argument;
  }
  if (selection === undefined) {
    throw new CliUsageError(PACKAGE_USAGE);
  }
  return { selection, ...(host === undefined ? {} : { host }), confirmed, ...(approvalAction === undefined ? {} : { approvalAction }) };
}

function parseHost(value: string): PackageHost {
  if (PACKAGE_HOSTS.includes(value as PackageHost)) {
    return value as PackageHost;
  }
  throw new CliUsageError(`Unsupported Package Host ${JSON.stringify(value)}; expected ${PACKAGE_HOSTS.join(" or ")}`);
}

function parseApprovalAction(value: string): PackageAction {
  if (value === "install" || value === "update" || value === "uninstall") {
    return value;
  }
  throw new CliUsageError("Package approval action must be install, update, or uninstall");
}

async function resolveSelection(
  args: SelectionArgs,
  packages: PackageOperations,
  sources: SourceOperations,
  preferRecorded = false,
): Promise<PackageSelection> {
  const token = parseSelectionToken(args.selection);
  const host = resolveHost(token, args.host);
  const recorded = await matchRecordedSelection(packages, args.selection, token, host);
  if (preferRecorded && recorded !== undefined) {
    return recorded;
  }
  const source = await resolveSource(sources, token.sourceToken);
  const descriptors = await packages.discover([source.source.id]);
  const descriptor = resolveDescriptor(descriptors, token, host);
  return Object.freeze({ ...descriptor.coordinates, source: source.projectSource, version: { policy: "latest" as const } });
}

async function matchRecordedSelection(
  packages: PackageOperations,
  raw: string,
  token: SelectionToken,
  host: PackageHost,
): Promise<PackageSelection | undefined> {
  const records = await packages.list();
  const direct = records.find((record) => packageSelectionMatches(record.selection, raw));
  if (direct !== undefined) {
    return direct.selection;
  }
  return records.find((record) => {
    if (record.selection.host !== host) {
      return false;
    }
    if (sourceToken(record.selection.source) !== token.sourceToken) {
      return false;
    }
    if (record.selection.host === "pi") {
      return record.selection.root === token.root;
    }
    return record.selection.marketplaceRoot === token.root &&
      (token.pluginName === undefined || record.selection.pluginName === token.pluginName);
  })?.selection;
}

function resolveDescriptor(
  descriptors: readonly BundleDescriptor[],
  token: SelectionToken,
  host: PackageHost,
): BundleDescriptor {
  const matches = descriptors.filter((descriptor) => {
    if (descriptor.host !== host || bundleRoot(descriptor.coordinates) !== token.root) {
      return false;
    }
    return descriptor.coordinates.host !== "claude" || token.pluginName === undefined || descriptor.coordinates.pluginName === token.pluginName;
  });
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Package selection ${JSON.stringify(token.root)} is ambiguous for Host ${host}; include #<plugin-name>`);
  }
  throw new Error(`No ${host} Package at ${JSON.stringify(displayRoot(token.root))} in Source ${JSON.stringify(token.sourceToken)}`);
}

function parseSelectionToken(selection: string): SelectionToken {
  const separator = selection.indexOf("::");
  if (separator <= 0 || separator === selection.length - 2) {
    throw new CliUsageError("Package selection must be <source-id>::<bundle-path> or <source-id>::<host>:<bundle-path>");
  }
  const sourceTokenValue = selection.slice(0, separator);
  let coordinate = selection.slice(separator + 2);
  let host: PackageHost | undefined;
  for (const candidate of PACKAGE_HOSTS) {
    const prefix = `${candidate}:`;
    if (coordinate.startsWith(prefix)) {
      host = candidate;
      coordinate = coordinate.slice(prefix.length);
      break;
    }
  }
  const hash = coordinate.indexOf("#");
  const rootPart = hash === -1 ? coordinate : coordinate.slice(0, hash);
  const pluginName = hash === -1 ? undefined : normalizePluginName(coordinate.slice(hash + 1));
  return Object.freeze({
    sourceToken: sourceTokenValue,
    ...(host === undefined ? {} : { host }),
    root: normalizeRoot(rootPart),
    ...(pluginName === undefined ? {} : { pluginName }),
  });
}

function resolveHost(token: SelectionToken, host: PackageHost | undefined): PackageHost {
  if (token.host !== undefined && host !== undefined && token.host !== host) {
    throw new CliUsageError(`Package selection Host ${token.host} conflicts with --host ${host}`);
  }
  const resolved = host ?? token.host;
  if (resolved === undefined) {
    throw new CliUsageError("Package selection needs --host pi or --host claude unless the selection is host-qualified");
  }
  if (resolved === "pi" && token.pluginName !== undefined) {
    throw new CliUsageError("Pi Package selections do not include a plugin name");
  }
  return resolved;
}

function normalizeRoot(value: string): string {
  if (value === "" || value === ".") {
    return "";
  }
  if (value.trim() !== value || value.startsWith("/") || value.includes("\\") || value.includes("#")) {
    throw new CliUsageError(`Package bundle path ${JSON.stringify(value)} is not a Source-relative directory`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || hasControlCharacter(part))) {
    throw new CliUsageError(`Package bundle path ${JSON.stringify(value)} is not a canonical Source-relative directory`);
  }
  return value;
}

function normalizePluginName(value: string): string {
  if (value === "" || value.trim() !== value || value.includes("/") || value.includes("\\") || value.includes("#") || /\s/u.test(value) || hasControlCharacter(value)) {
    throw new CliUsageError(`Package plugin name ${JSON.stringify(value)} is not valid`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

async function resolveSource(sources: SourceOperations, token: string): Promise<ResolvedSource> {
  const matches = (await sources.listSources()).filter((source) => sourceMatchesToken(source, token));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Source is not registered: ${token}`
      : `Source token ${JSON.stringify(token)} matches more than one Source`);
  }
  const source = matches[0]!;
  return Object.freeze({ source, projectSource: sourceToProjectSource(source) });
}

function sourceMatchesToken(source: Source, token: string): boolean {
  if (source.id === token) {
    return true;
  }
  return source.kind === "git" && (source.url === token || sourceToken(sourceToProjectSource(source)) === token);
}

function sourceToProjectSource(source: Source): ProjectSource {
  if (source.kind === "builtin") {
    return Object.freeze({ kind: "builtin" as const, id: source.id });
  }
  return Object.freeze({
    kind: "external" as const,
    url: source.url,
    ...(source.ref === undefined ? {} : { ref: source.ref }),
  });
}

function sourceToken(source: ProjectSource): string {
  if (source.kind === "builtin") {
    return source.id;
  }
  return "url" in source ? source.url : source.path;
}

/** The registered Source id: derived for a Git Source, and its own token otherwise. */
function sourceIdToken(source: ProjectSource): string {
  return "url" in source ? sourceIdForUrl(source.url) : sourceToken(source);
}

function formatDescriptorSelection(sourceId: string, descriptor: BundleDescriptor): string {
  return `${sourceId}::${describeSelectionCoordinate(descriptor.coordinates)}`;
}

function describeSelectionCoordinate(coordinates: PackageCoordinates): string {
  return coordinates.host === "pi"
    ? `pi:${displayRoot(coordinates.root)}`
    : `claude:${displayRoot(coordinates.marketplaceRoot)}#${coordinates.pluginName}`;
}

function formatPackageRecord(record: InstalledPackage): string {
  const verified = record.verified === undefined ? "unknown" : describeVersion(record.verified);
  return `Package ${formatPackageSelection(record.selection)}\tinstallId=${record.installId}\tverified=${verified}\tverifiedAt=${record.verifiedAt}`;
}

function describeInspection(
  selection: PackageSelection,
  inspection: PackageInspection,
  output: (line: string) => void,
): void {
  output(`Package inspect: ${formatPackageSelection(selection)}`);
  output(`  installed: ${describeEvidence(inspection.installed)}`);
  output(`  available: ${inspection.available === undefined ? "unknown" : describeVersion(inspection.available)}`);
  output(`  approval: ${inspection.approval}`);
  if (inspection.drift !== undefined) {
    output(`  drift: ${inspection.drift}`);
  }
  if (inspection.descriptor !== undefined) {
    describeDescriptor(inspection.descriptor, output, "  ");
  }
}

export function describeLifecyclePlan(
  plan: PackageLifecyclePlan,
  approval: "approved" | "needs approval",
  output: (line: string) => void,
): void {
  output(`Package ${plan.action} preview: ${formatPackageSelection(plan.selection)}`);
  output(`  approval: ${approval}`);
  output(`  origin: installId=${plan.origin.installId}; manifest=${plan.origin.manifestDigest}; commit=${plan.origin.resolvedCommit ?? "unknown"}`);
  describeDescriptor(plan.descriptor, output, "  ");
  output(`  host commands (${plan.commands.length}):`);
  if (plan.commands.length === 0) {
    output("    none");
  }
  for (const [index, command] of plan.commands.entries()) {
    output(`    [${index}] purpose=${command.purpose}; argv=${JSON.stringify([command.executable, ...command.args])}; resolved=${command.resolvedPath ?? "unresolved"}; summary=${command.summary}`);
  }
  output(`  affects (${plan.affects.length}):`);
  for (const coordinate of plan.affects) {
    output(`    ${describeCoordinates(coordinate)}`);
  }
  output(`  working directory: ${plan.cwd}`);
  output(`  environment: ${plan.environment}`);
  if (plan.skipExecution === true) {
    output("  host state already satisfies this action; execution will run no host command");
  }
  for (const warning of plan.warnings) {
    output(`  warning: ${warning}`);
  }
}

function describeDescriptor(
  descriptor: BundleDescriptor,
  output: (line: string) => void,
  indent: string,
): void {
  output(`${indent}descriptor: ${descriptor.name}; host=${descriptor.host}; coordinates=${describeCoordinates(descriptor.coordinates)}`);
  output(`${indent}version: ${descriptor.version === undefined ? "unknown" : describeVersion(descriptor.version)}`);
  output(`${indent}manifest digest: ${descriptor.manifestDigest}`);
  output(`${indent}components (${descriptor.components.length}):`);
  if (descriptor.components.length === 0) {
    output(`${indent}  none`);
  }
  for (const component of descriptor.components) {
    output(`${indent}  ${describeComponent(component)}`);
  }
  for (const warning of descriptor.warnings) {
    output(`${indent}warning: ${warning}`);
  }
}

const COMPONENT_RISK: Readonly<Record<PackageComponentEffect, string>> = Object.freeze({
  executable: "high: the host runs it",
  instruction: "medium: the host loads it into agent context",
  data: "low: data only",
});

function describeComponent(component: PackageComponent): string {
  const paths = component.paths.length === 0 ? "none" : component.paths.join(", ");
  const skills = component.skillNames === undefined || component.skillNames.length === 0
    ? ""
    : `; skills=${component.skillNames.join(", ")}`;
  return `${component.kind}: ownership=${component.ownership}; effect=${component.effect}; risk=${COMPONENT_RISK[component.effect]}; paths=${paths}${skills}`;
}

function describeVersion(version: PackageVersionEvidence): string {
  return version.kind === "manifest-version"
    ? `${version.version} (${version.declaredBy})`
    : `commit ${version.commit}`;
}

function describeEvidence(evidence: InstalledBundleEvidence): string {
  switch (evidence.kind) {
    case "installed": {
      if (evidence.version !== undefined) {
        return `installed ${evidence.version}`;
      }
      if (evidence.commit !== undefined) {
        return `installed commit ${evidence.commit}`;
      }
      return "installed with unknown version";
    }
    case "absent":
      return "absent";
    case "unknown":
      return `unknown (${evidence.reason})`;
  }
}

function packageResultSucceeded(result: PackageLifecycleResult): boolean {
  return result.status === "installed" || result.status === "updated" || result.status === "removed" ||
    result.status === "selected" || result.status === "forgotten";
}

function displayRoot(root: string): string {
  return root === "" ? "." : root;
}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`Missing value for ${option}`);
  }
  return value;
}
