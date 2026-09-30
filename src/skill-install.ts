import path from "node:path";

import { pathsOverlap } from "./path-safety.js";
import {
  inspectProjectSkillInstallation,
  installProjectSkillTransaction,
  validateProjectSkillInstallationPreview,
  type ProjectInstallationOptions,
  type ProjectSkillInstallationInspection,
  type ProjectSkillInstallationResult,
  type ProjectSkillInstallationTransaction,
  type ProjectSkillTreeAccess,
} from "./project-installation.js";
import {
  AGENT_DEPOT_PACKAGE_VERSION,
  parseProjectManifest,
  type ProjectHost,
  type ProjectSkillSelection,
  type ProjectSource,
  type ResolvedVersionEvidence,
  type VersionPolicy,
} from "./project-manifest.js";
import { createSourceContentAccess, type SkillTreeFile } from "./skill-discovery.js";
import { relativeProjectPath, selectionWithInstallation } from "./skill-update.js";
import {
  executeSourceInstallationMethod,
  parseSourceInstallationMethod,
  resolveProjectSource,
  SourceNotFoundError,
  type Source,
  type SourceInstallationMethod,
  type SourceOperations,
} from "./sources.js";
import { CliUsageError } from "./usage-error.js";

/**
 * Shared install flow for one Skill selection (project or user-global):
 * resolve, inspect, preview, then execute. Used by the CLI and the TUI.
 */

const INSTALL_USAGE = "Usage: agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--overwrite --yes] [--confirm-additional-host]";

/** Installation options that are not part of the Skill selection. */
export interface InstallOptionsSubset {
  readonly hosts: readonly ProjectHost[];
  readonly ref?: string;
  readonly method?: unknown;
  readonly portableV1: boolean;
  readonly confirmed: boolean;
  readonly overwrite: boolean;
  readonly confirmAdditionalHostExposure: boolean;
}

/** The part of the CLI dependencies the install flow needs. */
export interface InstallEnvironment {
  readonly installationOptions?: Omit<ProjectInstallationOptions, "projectRoot" | "sourceAccess">;
}


export type InstallSelectionOptions = InstallOptionsSubset & {
  readonly sourceId: string;
  readonly skillPath: string;
  readonly version: VersionPolicy;
};

export async function selectInstallSource(
  options: InstallSelectionOptions,
  operations: SourceOperations,
): Promise<{ source: Source; projectSource: ProjectSource; selection: ProjectSkillSelection }> {
  const source = await findSource(operations, options.sourceId);
  const projectSource = projectSourceFromSource(source, options.ref, options.version);
  const selection = parseProjectManifest({
    version: 1,
    skills: [{
      source: projectSource,
      path: options.skillPath,
      version: options.version,
      hosts: options.hosts,
      ...(options.method === undefined ? {} : { methods: { install: options.method } }),
    }],
  }).skills[0];
  if (!selection) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  if (!options.portableV1) {
    throw new CliUsageError("Compatibility is not known; rerun with --portable-v1 after reviewing the Skill");
  }
  return { source, projectSource, selection };
}

export async function resolveInstallInspection(
  selection: ProjectSkillSelection,
  source: Source,
  projectSource: ProjectSource,
  installationRoot: string,
  options: InstallOptionsSubset,
  operations: SourceOperations,
  dependencies: InstallEnvironment,
  sourceAccess: ProjectSkillTreeAccess,
) {
  const initialResolvedSource = projectSource.kind === "builtin"
    ? source
    : operations.resolveProjectSource
      ? await operations.resolveProjectSource(projectSource)
      : resolveProjectSource(projectSource);
  const resolvedSource = await refreshResolvedSource(operations, projectSource, initialResolvedSource, options.confirmed);
  const resolved = await resolveSelection(selection, resolvedSource, operations, sourceAccess);
  const installationInspection = await inspectProjectSkillInstallation({
    selection,
    source: resolvedSource,
    previewTree: resolved.files,
    portableV1: options.portableV1,
    confirmAdditionalHostExposure: options.confirmAdditionalHostExposure,
    resolvedVersion: resolved.resolvedVersion,
  }, {
    projectRoot: installationRoot,
    sourceAccess,
    ...dependencies.installationOptions,
  });
  return { resolvedSource, resolved, installationInspection };
}

export interface ResolvedManifestSelection {
  readonly selection: ProjectSkillSelection;
  readonly source: Source;
  readonly files: readonly SkillTreeFile[];
  readonly resolvedVersion?: ResolvedVersionEvidence;
  readonly method?: SourceInstallationMethod;
}

export async function resolveSelection(
  selection: ProjectSkillSelection,
  source: Source,
  operations: SourceOperations,
  sourceAccess: ProjectSkillTreeAccess,
): Promise<ResolvedManifestSelection> {
  const preview = await readPreviewTree(sourceAccess, source, selection);
  await validateProjectSkillInstallationPreview({
    selection,
    source,
    previewTree: preview.files,
    portableV1: true,
  }, sourceAccess);
  // An explicitly configured method is authoritative. Avoid reading source metadata
  // when it is present so an invalid fallback cannot override user intent.
  const method = selection.methods?.install ?? await readStructuredMethod(operations, source, selection.path, preview.files);
  // The default Source access returns this evidence with the immutable tree. The
  // resolver fallback preserves compatibility for embedders with the older seam.
  const resolvedVersion = preview.resolvedVersion
    ?? await operations.resolveSourceVersion?.(source)
    ?? (source.kind === "builtin" && AGENT_DEPOT_PACKAGE_VERSION !== undefined
      ? Object.freeze({ kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION })
      : undefined);
  return Object.freeze({ selection, source, files: preview.files, resolvedVersion, method });
}

export interface PreviewTree {
  readonly files: readonly SkillTreeFile[];
  readonly resolvedVersion?: ResolvedVersionEvidence;
}

export async function refreshResolvedSource(
  operations: SourceOperations,
  projectSource: ProjectSource,
  source: Source,
  confirmed: boolean,
): Promise<Source> {
  if (!confirmed || source.kind === "builtin" || !operations.refreshProjectSource) {
    return source;
  }
  const refreshed = await operations.refreshProjectSource(projectSource);
  if (refreshed.kind !== source.kind || refreshed.id !== source.id ||
    (refreshed.kind === "git" && source.kind === "git" && refreshed.url !== source.url)) {
    throw new Error(`Refreshed Source identity changed from ${JSON.stringify(source.id)} to ${JSON.stringify(refreshed.id)}; no installation was attempted`);
  }
  return refreshed;
}

export async function readPreviewTree(
  sourceAccess: ProjectSkillTreeAccess,
  source: Source,
  selection: ProjectSkillSelection,
): Promise<PreviewTree> {
  const captured = sourceAccess.readSkillTreeSnapshot
    ? await sourceAccess.readSkillTreeSnapshot(source, selection.path)
    : { files: await sourceAccess.readSkillTree(source, selection.path) };
  const prefix = `${selection.path}/`;
  const files = captured.files;
  if (!files.some((file) => file.path === `${selection.path}/SKILL.md`)) {
    throw new Error(`Selected Skill ${JSON.stringify(selection.path)} does not contain SKILL.md`);
  }
  const seen = new Set<string>();
  const snapshot = files.map((file) => {
    const relativePath = file.path.slice(prefix.length);
    if (!file.path.startsWith(prefix) || !isSafePreviewPath(relativePath) || seen.has(relativePath)) {
      throw new Error(`Selected Skill returned an unsafe or duplicate file path: ${JSON.stringify(file.path)}`);
    }
    seen.add(relativePath);
    return Object.freeze({
      path: file.path,
      content: Uint8Array.from(file.content),
      executable: file.executable,
    });
  });
  return Object.freeze({ files: Object.freeze(snapshot), resolvedVersion: captured.resolvedVersion });
}

export function isSafePreviewPath(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../") &&
    normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export async function readStructuredMethod(
  operations: SourceOperations,
  source: Source,
  skillPath: string,
  previewTree: readonly SkillTreeFile[],
): Promise<SourceInstallationMethod | undefined> {
  if (!operations.readInstallationMethod) {
    return undefined;
  }
  const metadata = await operations.readInstallationMethod(source, skillPath, previewTree);
  return metadata === undefined ? undefined : parseSourceInstallationMethod(metadata);
}

export function outputInstallPreview(
  selection: ProjectSkillSelection,
  source: Source,
  projectRoot: string,
  output: (line: string) => void,
  files: readonly SkillTreeFile[],
  method: SourceInstallationMethod | undefined,
  scope: "project" | "user-global",
  inspection: ProjectSkillInstallationInspection | undefined,
  overwrite: boolean,
  confirmed: boolean,
): void {
  const skillName = path.posix.basename(selection.path);
  const canonicalPath = path.join(projectRoot, ".agents", "skills", skillName);
  const claudePath = path.join(projectRoot, ".claude", "skills", skillName);
  output(`Preview: reconcile Skill ${JSON.stringify(skillName)} from ${source.id} (destination determined by safe inspection)`);
  output(`  scope: ${scope}; hosts: ${selection.hosts.join(",")}; version policy: ${formatVersionPolicy(selection.version)}`);
  if (inspection) {
    output(`  target: ${inspection.targetPath}`);
    if (inspection.collision) {
      output(`  COLLISION: ${inspection.collision.path} (${inspection.collision.reason})`);
      if (overwrite && confirmed) {
        output("  collision handling: target will be replaced because --overwrite --yes was supplied");
        output(`  overwrite backup: old Skill will be moved to a retained backup at ${backupPreviewPath(inspection.targetPath)} (generated at transaction time; never pruned automatically)`);
      } else if (overwrite) {
        output("  collision handling: fail-closed; no path will be changed without --yes; rerun with --overwrite --yes to replace the target");
        output(`  if confirmed: old Skill would be moved to a retained backup at ${backupPreviewPath(inspection.targetPath)}`);
      } else {
        output("  collision handling: fail-closed; no path will be changed; explicit overwrite requires --overwrite --yes");
      }
    } else if (inspection.locations.some((location) => location.status === "identical")) {
      output("  collision status: existing content is identical and can be adopted without replacement");
    } else {
      output("  collision status: target is absent and will be created");
    }
  }
  output(confirmed
    ? "  confirmation: --yes supplied; changes remain subject to final safety checks"
    : "  confirmation: no --yes supplied; zero files or installation state will be changed");
  output("  intended filesystem changes:");
  if (inspection?.collision && overwrite) {
    output(`    replace the colliding target at ${inspection.targetPath}, retain a backup of the existing Skill at ${backupPreviewPath(inspection.targetPath)}, and install the selected source files`);
  } else {
    output("    reconcile the selected source files below: adopt identical files, create missing files, and refuse conflicts");
  }
  output("  selected source files:");
  for (const file of files) {
    const action = inspection?.collision && overwrite ? "install into the replacement target" : "adopt if identical, create if missing";
    output(`    ${file.path} (${file.content.byteLength} bytes${file.executable ? ", executable" : ""}; ${action})`);
  }
  output(`  possible ${scope} locations:`);
  output(`    ${canonicalPath} (canonical Host location; safe inspection determines whether this is used)`);
  if (selection.hosts.includes("claude")) {
    output(`    ${claudePath} (Claude Host location; fresh install exposes the canonical location by symlink with --yes)`);
  }
  if (method) {
    const cwd = path.resolve(projectRoot, method.cwd ?? ".");
    output(`  run external method: argv=${JSON.stringify(method.argv)} executable=${JSON.stringify(method.argv[0])} args=${JSON.stringify(method.argv.slice(1))} cwd=${JSON.stringify(cwd)}`);
  }
}

export function backupPreviewPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), ".agent-depot-backup-<generated-suffix>");
}

export function assertNoManagedInstallationOverlap(
  managed: readonly ProjectSkillSelection[],
  selection: ProjectSkillSelection,
  inspection: ProjectSkillInstallationInspection,
  projectRoot: string,
  overwrite: boolean,
): readonly string[] {
  const protectedPaths = managed
    .filter((candidate) => !sameSelectionIdentity(candidate, selection))
    .flatMap((candidate) => candidate.installation?.path === undefined
      ? []
      : [path.resolve(projectRoot, ...candidate.installation.path.split("/"))]);
  if (!overwrite) return Object.freeze(protectedPaths);
  const conflicting = protectedPaths.find((candidate) => pathsOverlap(path.resolve(candidate), path.resolve(inspection.targetPath)));
  if (conflicting !== undefined) {
    throw new CliUsageError(
      `Cannot overwrite ${JSON.stringify(inspection.targetPath)} because it overlaps the managed installation ${JSON.stringify(conflicting)} belonging to another Source/Skill selection; no path was changed.`,
    );
  }
  return Object.freeze(protectedPaths);
}

export function sameSelectionIdentity(left: ProjectSkillSelection, right: ProjectSkillSelection): boolean {
  return JSON.stringify([left.source, left.path]) === JSON.stringify([right.source, right.path]);
}

export function rejectInstallationCollision(
  inspection: ProjectSkillInstallationInspection,
  overwrite: boolean,
): void {
  if (!inspection.collision) return;
  const detail = `Cannot install because ${JSON.stringify(inspection.collision.path)} has a ${inspection.collision.reason} collision; no path was changed.`;
  if (inspection.collision.reason !== "missing-file" && inspection.collision.reason !== "extra-file" && inspection.collision.reason !== "content-mismatch") {
    throw new CliUsageError(`${detail} Unsafe targets cannot be overwritten.`);
  }
  if (overwrite) {
    return;
  }
  throw new CliUsageError(`${detail} Explicit overwrite requires --overwrite --yes.`);
}

export function formatVersionPolicy(version: VersionPolicy): string {
  return version.policy === "latest" ? "latest" : `fixed:${version.version}`;
}

export function outputInstallationResult(
  result: ProjectSkillInstallationResult,
  projectRoot: string,
  output: (line: string) => void,
): void {
  const locations = result.adopted
    ? result.adoptedPaths
    : [result.canonicalPath];
  const rendered = locations.map((location) => relativeProjectPath(projectRoot, location)).join(", ");
  output(`${result.adopted ? "Adopted" : "Installed"} Skill ${JSON.stringify(result.skillName)} at ${rendered}`);
  if (result.backupPath !== undefined) {
    output(`  Persistent backup retained at ${result.backupPath}`);
  }
}

export async function installOne(
  selection: ProjectSkillSelection,
  source: Source,
  sourceAccess: ProjectSkillTreeAccess,
  projectRoot: string,
  dependencies: InstallEnvironment,
  method: SourceInstallationMethod | undefined,
  portableV1: boolean,
  files: readonly SkillTreeFile[],
  resolvedVersion: ResolvedVersionEvidence | undefined,
  confirmAdditionalHostExposure: boolean,
  overwrite: boolean,
  inspection?: ProjectSkillInstallationInspection,
  protectedPaths: readonly string[] = [],
): Promise<ProjectSkillInstallationTransaction> {
  return installProjectSkillTransaction({
    selection,
    source,
    previewTree: files,
    portableV1,
    resolvedVersion,
    confirmAdditionalHostExposure,
    overwrite,
    ...(inspection === undefined ? {} : { inspection }),
    protectedPaths,
  }, {
    projectRoot,
    sourceAccess,
    ...dependencies.installationOptions,
  });
}

export async function executeOrRejectMethod(
  item: ResolvedManifestSelection,
  operations: SourceOperations,
  projectRoot: string,
): Promise<void> {
  if (!item.method) {
    return;
  }
  const executor = operations.executeInstallationMethod ?? executeSourceInstallationMethod;
  await executor(item.method, {
    source: item.source,
    skillPath: item.selection.path,
    projectRoot,
  });
}

export function externalMethodFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `External installation method failed after installation and manifest persistence; ` +
    `installed files were retained because method side effects cannot be rolled back: ${detail}`,
  );
}

export async function rollbackTransactions(
  transactions: readonly ProjectSkillInstallationTransaction[],
  original: unknown,
): Promise<never> {
  const rollbackErrors: string[] = [];
  for (const transaction of [...transactions].reverse()) {
    try {
      await transaction.rollback();
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (rollbackErrors.length > 0) {
    const message = original instanceof Error ? original.message : String(original);
    throw new Error(`${message}; batch rollback failed: ${rollbackErrors.join("; ")}`);
  }
  throw original;
}

export function defaultProjectSkillTreeAccess(): ProjectSkillTreeAccess {
  const access = createSourceContentAccess();
  if (!access.readSkillTree) {
    throw new Error("Configured Source content access cannot read complete Skill trees");
  }
  return {
    readSkillTree: (source, skillPath) => access.readSkillTree!(source, skillPath),
    ...(access.readSkillTreeSnapshot === undefined
      ? {}
      : { readSkillTreeSnapshot: (source: Source, skillPath: string) => access.readSkillTreeSnapshot!(source, skillPath) }),
  };
}

export function projectSourceFromSource(source: Source, ref: string | undefined, version: VersionPolicy): ProjectSource {
  if (source.kind === "builtin") {
    if (ref !== undefined) {
      throw new CliUsageError("The built-in Source does not support --ref; its version follows the Agent Depot package");
    }
    return { kind: "builtin", id: source.id };
  }
  const selectedRef = ref ?? (version.policy === "fixed" ? version.version : source.ref);
  return { kind: "external", url: source.url, ...(selectedRef === undefined ? {} : { ref: selectedRef }) };
}

export async function findSource(operations: SourceOperations, sourceId: string): Promise<Source> {
  const source = (await operations.listSources()).find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new SourceNotFoundError(sourceId);
  }
  return source;
}

/** One Skill install request; the scope decides where the installation root is. */
export interface SingleInstallRequest extends InstallOptionsSubset {
  readonly scope: "project" | "user-global";
  readonly sourceId: string;
  readonly skillPath: string;
  readonly version: VersionPolicy;
}

export interface SingleInstallContext {
  readonly operations: SourceOperations;
  readonly sourceAccess: ProjectSkillTreeAccess;
  readonly environment: InstallEnvironment;
  /** Project root or home directory the Skill is installed under. */
  readonly root: string;
  /** Selections already recorded for this scope; a duplicate is rejected. */
  readonly existing: readonly ProjectSkillSelection[];
  /** Where those records live, used in the duplicate error message. */
  readonly recordedIn: string;
}

export interface SingleInstallPlan {
  readonly request: SingleInstallRequest;
  readonly context: SingleInstallContext;
  readonly selection: ProjectSkillSelection;
  readonly source: Source;
  readonly resolvedSource: Source;
  readonly resolved: ResolvedManifestSelection;
  readonly inspection: ProjectSkillInstallationInspection;
}

/** Plan step: select, reject duplicates, resolve and inspect. Changes nothing. */
export async function planSingleInstall(
  request: SingleInstallRequest,
  context: SingleInstallContext,
): Promise<SingleInstallPlan> {
  const { source, projectSource, selection } = await selectInstallSource(request, context.operations);
  if (context.existing.some((candidate) => JSON.stringify([candidate.source, candidate.path]) === JSON.stringify([selection.source, selection.path]))) {
    throw new CliUsageError(`Skill selection ${JSON.stringify(selection.path)} is already recorded in ${context.recordedIn}; already managed Skills must be changed with update apply`);
  }
  const { resolvedSource, resolved, installationInspection } = await resolveInstallInspection(
    selection, source, projectSource, context.root, request, context.operations, context.environment, context.sourceAccess,
  );
  return { request, context, selection, source, resolvedSource, resolved, inspection: installationInspection };
}

/** Prints the preview the user confirms before {@link executeSingleInstall}. */
export function outputSingleInstallPreview(plan: SingleInstallPlan, output: (line: string) => void): void {
  const { request, context, selection, source, resolved, inspection } = plan;
  outputInstallPreview(selection, source, context.root, output, resolved.files, resolved.method, request.scope, inspection, request.overwrite, request.confirmed);
}

/**
 * Execute step: collision checks, install, persist the record (rolling the
 * files back if persisting fails), then run the external method if any.
 */
export async function executeSingleInstall(
  plan: SingleInstallPlan,
  persist: (record: ProjectSkillSelection) => Promise<void>,
  output: (line: string) => void,
): Promise<void> {
  const { request, context, selection, resolvedSource, resolved, inspection } = plan;
  const protectedPaths = assertNoManagedInstallationOverlap(context.existing, selection, inspection, context.root, request.overwrite);
  rejectInstallationCollision(inspection, request.overwrite);
  const transaction = await installOne(
    selection,
    resolvedSource,
    context.sourceAccess,
    context.root,
    context.environment,
    resolved.method,
    request.portableV1,
    resolved.files,
    resolved.resolvedVersion,
    request.confirmAdditionalHostExposure,
    request.overwrite,
    inspection,
    protectedPaths,
  );
  try {
    await persist(selectionWithInstallation(selection, transaction.result, context.root));
  } catch (error) {
    await rollbackTransactions([transaction], error);
  }
  outputInstallationResult(transaction.result, context.root, output);
  try {
    await executeOrRejectMethod(resolved, context.operations, context.root);
  } catch (error) {
    throw externalMethodFailure(error);
  }
}

/** A fixed version must be non-empty with no whitespace or control characters. */
export function isValidFixedVersion(version: string): boolean {
  return version.length > 0 && !/\s/u.test(version) && !Array.from(version).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * True when the install would adopt an identical existing Skill but a selected
 * Host location is missing, which the CLI only allows with --confirm-additional-host.
 */
export function needsAdditionalHostExposure(
  inspection: ProjectSkillInstallationInspection,
  hosts: readonly ProjectHost[],
): boolean {
  const identical = inspection.locations.filter((location) => location.status === "identical").map((location) => location.path);
  if (identical.length === 0) return false;
  const missingClaude = hosts.includes("claude") && !identical.includes(inspection.claudePath);
  const missingCanonical = hosts.some((host) => host !== "claude") && !identical.includes(inspection.canonicalPath);
  return missingClaude || missingCanonical;
}
