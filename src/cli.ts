#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createSourceContentAccess, type SkillCandidate, type SkillTreeFile } from "./skill-discovery.js";
import {
  BuiltInSourceError,
  createSourceOperations,
  executeSourceInstallationMethod,
  parseSourceInstallationMethod,
  resolveProjectSource,
  SourceMetadataError,
  SourceNotFoundError,
  type Source,
  type SourceInstallationMethod,
  type SourceOperations,
} from "./sources.js";
import {
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
  PROJECT_HOSTS,
  type ProjectHost,
  type ProjectManifest,
  type ProjectSkillSelection,
  type ProjectSource,
  type VersionPolicy,
} from "./project-manifest.js";
import {
  installProjectSkillTransaction,
  type ProjectInstallationOptions,
  type ProjectSkillInstallationResult,
  type ProjectSkillInstallationTransaction,
  type ProjectSkillTreeAccess,
} from "./project-installation.js";

export interface CliDependencies {
  readonly operations?: SourceOperations;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly projectRoot?: string;
  readonly sourceAccess?: ProjectSkillTreeAccess;
  readonly installationOptions?: Omit<ProjectInstallationOptions, "projectRoot" | "sourceAccess">;
  /** Test/embedding seam for the manifest transaction boundary. */
  readonly projectManifestStore?: ProjectManifestStore;
  /** Home directory used by user-global installation; injectable for tests. */
  readonly homeDirectory?: string;
}

const USAGE = [
  "Usage:",
  "  agent-depot source list",
  "  agent-depot source add <url>",
  "  agent-depot source refresh <id> [--yes]",
  "  agent-depot discover <source-id> [source-id...]",
  "  agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--yes] [--confirm-additional-host]",
  "  agent-depot install --scope project --manifest --portable-v1 [--yes] [--confirm-additional-host]",
].join("\n");
const INSTALL_USAGE = "Usage: agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--yes] [--confirm-additional-host]";
const DISCOVER_USAGE = "Usage: agent-depot discover <source-id> [source-id...]\nSelect at least one Source ID explicitly; run `agent-depot source list` to see registered Sources";

/** Runs the CLI application and returns a process exit code. */
export async function runCli(argv: readonly string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.stdout ?? ((line: string) => console.log(line));
  const errorOutput = dependencies.stderr ?? ((line: string) => console.error(line));
  const operations = dependencies.operations ?? createSourceOperations({ homeDirectory: dependencies.homeDirectory });

  try {
    if (argv[0] === "install") {
      await runInstall(argv.slice(1), operations, dependencies, output);
      return 0;
    }

    if (argv[0] === "discover") {
      const sourceIds = argv.slice(1);
      requireSourceIds(sourceIds);
      const discoverSkills = operations.discoverSkills;
      if (!discoverSkills) {
        throw new CliUsageError("Discovery is unavailable in the configured Source operations");
      }

      let candidates: readonly SkillCandidate[];
      try {
        candidates = await discoverSkills.call(operations, sourceIds);
      } catch (error) {
        throw new Error(formatDiscoveryError(error));
      }
      for (const candidate of candidates) {
        output(formatCandidate(candidate));
      }
      return 0;
    }

    if (argv[0] !== "source") {
      throw new CliUsageError(USAGE);
    }

    const action = argv[1];
    const values = argv.slice(2);
    switch (action) {
      case "list":
        requireArgumentCount(values, 0, "source list");
        for (const source of await operations.listSources()) {
          output(formatSource(source));
        }
        return 0;
      case "add":
        requireArgumentCount(values, 1, "source add <url>");
        {
          const source = await operations.addGitSource(values[0]);
          output(`Added Git Source: ${source.id}\t${source.url}`);
        }
        return 0;
      case "refresh":
        if (values.length < 1 || values.length > 2 || (values.length === 2 && values[1] !== "--yes")) {
          throw new CliUsageError("Usage: agent-depot source refresh <id> [--yes]");
        }
        {
          const source = await findSource(operations, values[0]);
          if (source.kind === "builtin") {
            throw new BuiltInSourceError();
          }
          output(`Preview: refresh Git Source ${source.id} from ${source.url}`);
          if (values[1] !== "--yes") {
            throw new CliUsageError("Refresh not confirmed; rerun with --yes to continue");
          }
          const refreshed = await operations.refreshSource(source.id);
          output(`Refreshed Git Source: ${refreshed.id}\t${refreshed.url}`);
        }
        return 0;
      default:
        throw new CliUsageError(USAGE);
    }
  } catch (error) {
    errorOutput(`Error: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

/** Alias retained as a discoverable public CLI seam for embedding and tests. */
export const main = runCli;

async function runInstall(
  argv: readonly string[],
  operations: SourceOperations,
  dependencies: CliDependencies,
  output: (line: string) => void,
): Promise<void> {
  const options = parseInstallOptions(argv);
  const sourceAccess = dependencies.sourceAccess ?? defaultProjectSkillTreeAccess();
  if (options.scope === "user-global") {
    await runUserGlobalInstall(options, operations, dependencies, sourceAccess, output);
    return;
  }

  const projectRoot = path.resolve(dependencies.projectRoot ?? process.cwd());
  const manifestStore = dependencies.projectManifestStore ?? new ProjectManifestStore(defaultProjectManifestPath(projectRoot));

  if (options.fromManifest) {
    const manifest = await manifestStore.load();
    if (manifest.skills.length === 0) {
      throw new CliUsageError("The project manifest contains no selected Skills");
    }
    if (!options.portableV1) {
      throw new CliUsageError("Compatibility is not known for a manifest install; rerun with --portable-v1 after reviewing the Skill");
    }
    const resolved = await resolveManifestSelections(manifest, operations, sourceAccess, options.confirmed);
    if (resolved.some((item) => item.method !== undefined) && resolved.length > 1) {
      throw new SourceMetadataError("A batch install containing an external method is refused because command side effects cannot be rolled back safely; install that Skill separately");
    }
    for (const item of resolved) {
      outputInstallPreview(item.selection, item.source, projectRoot, output, item.files, item.method, "project");
    }
    requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");

    const transactions: ProjectSkillInstallationTransaction[] = [];
    const installed: Array<{ readonly item: ResolvedManifestSelection; readonly result: ProjectSkillInstallationResult }> = [];
    let methodFailed = false;
    try {
      for (const item of resolved) {
        const transaction = await installOne(item.selection, item.source, sourceAccess, projectRoot, dependencies, item.method, options.portableV1, item.files, options.confirmAdditionalHostExposure);
        if (transaction) {
          transactions.push(transaction);
          installed.push({ item, result: transaction.result });
        }
      }
      const nextManifest = parseProjectManifest({
        version: 1,
        skills: manifest.skills.map((selection) => {
          const installedSelection = installed.find(({ item }) =>
            JSON.stringify([item.selection.source, item.selection.path]) === JSON.stringify([selection.source, selection.path]),
          );
          return installedSelection === undefined
            ? selection
            : selectionWithInstallation(installedSelection.item.selection, installedSelection.result, projectRoot);
        }),
      });
      await manifestStore.save(nextManifest);
      for (const { item, result } of installed) {
        outputInstallationResult(result, projectRoot, output);
        try {
          await executeOrRejectMethod(item, operations, projectRoot);
        } catch (error) {
          methodFailed = true;
          throw externalMethodFailure(error);
        }
      }
    } catch (error) {
      if (methodFailed) {
        throw error;
      }
      await rollbackTransactions(transactions, error);
    }
    return;
  }

  if (!options.sourceId || !options.skillPath || !options.version || options.hosts.length === 0) {
    throw new CliUsageError(INSTALL_USAGE);
  }
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

  const existing = await manifestStore.load();
  if (existing.skills.some((candidate) => JSON.stringify(candidate.source) === JSON.stringify(selection.source) && candidate.path === selection.path)) {
    throw new CliUsageError(`Skill selection ${JSON.stringify(selection.path)} is already recorded in ${manifestStore.path}; repeat installs never overwrite existing paths`);
  }
  const resolvedSource = projectSource.kind === "builtin"
    ? source
    : operations.resolveProjectSource
      ? await operations.resolveProjectSource(projectSource)
      : resolveProjectSource(projectSource);
  await refreshResolvedSource(operations, projectSource, resolvedSource, options.confirmed);
  const resolved = await resolveSelection(selection, resolvedSource, operations, sourceAccess);
  outputInstallPreview(selection, source, projectRoot, output, resolved.files, resolved.method, "project");
  requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");

  const transaction = await installOne(selection, resolvedSource, sourceAccess, projectRoot, dependencies, resolved.method, options.portableV1, resolved.files, options.confirmAdditionalHostExposure);
  const nextManifest = parseProjectManifest({
    version: 1,
    skills: [...existing.skills, selectionWithInstallation(selection, transaction.result, projectRoot)],
  });
  try {
    await manifestStore.save(nextManifest);
  } catch (error) {
    if (transaction) {
      await rollbackTransactions([transaction], error);
    }
    throw error;
  }
  outputInstallationResult(transaction.result, projectRoot, output);
  try {
    await executeOrRejectMethod(resolved, operations, projectRoot);
  } catch (error) {
    throw externalMethodFailure(error);
  }
  output(`Saved project manifest: ${manifestStore.path}`);
}

async function runUserGlobalInstall(
  options: InstallOptions,
  operations: SourceOperations,
  dependencies: CliDependencies,
  sourceAccess: ProjectSkillTreeAccess,
  output: (line: string) => void,
): Promise<void> {
  if (options.fromManifest || !options.sourceId || !options.skillPath || !options.version || options.hosts.length === 0) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  if (!operations.listUserGlobalInstallations || !operations.addUserGlobalInstallation) {
    throw new Error("Configured Source operations cannot manage user-global installation state");
  }

  const homeDirectory = path.resolve(dependencies.homeDirectory ?? homedir());
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

  const existing = await operations.listUserGlobalInstallations();
  if (existing.some((candidate) => JSON.stringify([candidate.source, candidate.path]) === JSON.stringify([selection.source, selection.path]))) {
    throw new CliUsageError(`Skill selection ${JSON.stringify(selection.path)} is already recorded in user-global state`);
  }
  const resolvedSource = projectSource.kind === "builtin"
    ? source
    : operations.resolveProjectSource
      ? await operations.resolveProjectSource(projectSource)
      : resolveProjectSource(projectSource);
  await refreshResolvedSource(operations, projectSource, resolvedSource, options.confirmed);
  const resolved = await resolveSelection(selection, resolvedSource, operations, sourceAccess);
  outputInstallPreview(selection, source, homeDirectory, output, resolved.files, resolved.method, "user-global");
  requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");

  const transaction = await installOne(
    selection,
    resolvedSource,
    sourceAccess,
    homeDirectory,
    dependencies,
    resolved.method,
    options.portableV1,
    resolved.files,
    options.confirmAdditionalHostExposure,
  );
  const record = selectionWithInstallation(selection, transaction.result, homeDirectory);
  try {
    await operations.addUserGlobalInstallation(record);
  } catch (error) {
    await rollbackTransactions([transaction], error);
  }
  outputInstallationResult(transaction.result, homeDirectory, output);
  try {
    await executeOrRejectMethod(resolved, operations, homeDirectory);
  } catch (error) {
    throw externalMethodFailure(error);
  }
  output("Saved user-global installation state: shared Source state");
}

interface InstallOptions {
  readonly scope: "project" | "user-global";
  readonly fromManifest: boolean;
  readonly sourceId?: string;
  readonly skillPath?: string;
  readonly hosts: readonly ProjectHost[];
  readonly version?: VersionPolicy;
  readonly ref?: string;
  readonly method?: unknown;
  readonly portableV1: boolean;
  readonly confirmed: boolean;
  readonly confirmAdditionalHostExposure: boolean;
}

function parseInstallOptions(argv: readonly string[]): InstallOptions {
  let scope: string | undefined;
  let sourceId: string | undefined;
  let skillPath: string | undefined;
  let versionValue: string | undefined;
  let ref: string | undefined;
  let method: unknown;
  let fromManifest = false;
  let portableV1 = false;
  let confirmed = false;
  let confirmAdditionalHostExposure = false;
  const hosts: ProjectHost[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--scope":
        scope = requireOptionValue(argv, ++index, "--scope");
        break;
      case "--source":
        sourceId = requireOptionValue(argv, ++index, "--source");
        break;
      case "--skill":
        skillPath = requireOptionValue(argv, ++index, "--skill");
        break;
      case "--host":
        for (const host of requireOptionValue(argv, ++index, "--host").split(",")) {
          if (!PROJECT_HOSTS.includes(host as ProjectHost) || hosts.includes(host as ProjectHost)) {
            throw new CliUsageError(`Unsupported or duplicate Host ${JSON.stringify(host)}`);
          }
          hosts.push(host as ProjectHost);
        }
        break;
      case "--version":
        versionValue = requireOptionValue(argv, ++index, "--version");
        break;
      case "--ref":
        ref = requireOptionValue(argv, ++index, "--ref");
        break;
      case "--method":
        method = parseMethodOption(requireOptionValue(argv, ++index, "--method"));
        break;
      case "--manifest":
        fromManifest = true;
        break;
      case "--portable-v1":
        portableV1 = true;
        break;
      case "--yes":
        confirmed = true;
        break;
      case "--confirm-additional-host":
        confirmAdditionalHostExposure = true;
        break;
      default:
        throw new CliUsageError(INSTALL_USAGE);
    }
  }

  if (scope !== "project" && scope !== "user-global") {
    throw new CliUsageError("Installation scope must be explicit: use --scope project or --scope user-global");
  }
  if (fromManifest && scope !== "project") {
    throw new CliUsageError("--manifest is only supported with --scope project");
  }
  if (fromManifest && (sourceId !== undefined || skillPath !== undefined || versionValue !== undefined || ref !== undefined || method !== undefined || hosts.length > 0)) {
    throw new CliUsageError("--manifest cannot be combined with --source, --skill, --host, --version, --ref, or --method");
  }
  if (!fromManifest && !versionValue && (sourceId || skillPath || ref || hosts.length > 0)) {
    throw new CliUsageError("--version is required for a selected Skill");
  }
  if (!fromManifest && versionValue === undefined && sourceId === undefined && skillPath === undefined && ref === undefined && hosts.length === 0) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  return {
    scope: scope as "project" | "user-global",
    fromManifest,
    sourceId,
    skillPath,
    hosts: Object.freeze(hosts),
    version: versionValue === undefined ? undefined : parseVersionOption(versionValue),
    ref,
    method,
    portableV1,
    confirmed,
    confirmAdditionalHostExposure,
  };
}

function parseMethodOption(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new CliUsageError(`--method must be valid JSON${detail}`);
  }
}

function parseVersionOption(value: string): VersionPolicy {
  if (value === "latest") {
    return { policy: "latest" };
  }
  const version = value.startsWith("fixed:") ? value.slice("fixed:".length) : value;
  if (!version || /\s|[\u0000-\u001f\u007f]/u.test(version)) {
    throw new CliUsageError("--version fixed:<value> must provide a non-empty version without whitespace or control characters");
  }
  return { policy: "fixed", version };
}

function requireOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`Missing value for ${option}`);
  }
  return value;
}

interface ResolvedManifestSelection {
  readonly selection: ProjectSkillSelection;
  readonly source: Source;
  readonly files: readonly SkillTreeFile[];
  readonly method?: SourceInstallationMethod;
}

async function resolveManifestSelections(
  manifest: ProjectManifest,
  operations: SourceOperations,
  sourceAccess: ProjectSkillTreeAccess,
  confirmed: boolean,
): Promise<readonly ResolvedManifestSelection[]> {
  const resolved: ResolvedManifestSelection[] = [];
  for (const selection of manifest.skills) {
    const source = operations.resolveProjectSource
      ? await operations.resolveProjectSource(selection.source)
      : resolveProjectSource(selection.source);
    await refreshResolvedSource(operations, selection.source, source, confirmed);
    resolved.push(await resolveSelection(selection, source, operations, sourceAccess));
  }
  return Object.freeze(resolved);
}

async function resolveSelection(
  selection: ProjectSkillSelection,
  source: Source,
  operations: SourceOperations,
  sourceAccess: ProjectSkillTreeAccess,
): Promise<ResolvedManifestSelection> {
  const files = await readPreviewTree(sourceAccess, source, selection);
  // An explicitly configured method is authoritative. Avoid reading source metadata
  // when it is present so an invalid fallback cannot override user intent.
  const method = selection.methods?.install ?? await readStructuredMethod(operations, source, selection.path, files);
  return Object.freeze({ selection, source, files, method });
}

async function refreshResolvedSource(
  operations: SourceOperations,
  projectSource: ProjectSource,
  source: Source,
  confirmed: boolean,
): Promise<void> {
  if (!confirmed || source.kind === "builtin" || !operations.refreshProjectSource) {
    return;
  }
  await operations.refreshProjectSource(projectSource);
}

async function readPreviewTree(
  sourceAccess: ProjectSkillTreeAccess,
  source: Source,
  selection: ProjectSkillSelection,
): Promise<readonly SkillTreeFile[]> {
  const files = await sourceAccess.readSkillTree(source, selection.path);
  const prefix = `${selection.path}/`;
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
  return Object.freeze(snapshot);
}

function isSafePreviewPath(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../") &&
    normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function readStructuredMethod(
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

function outputInstallPreview(
  selection: ProjectSkillSelection,
  source: Source,
  projectRoot: string,
  output: (line: string) => void,
  files: readonly SkillTreeFile[],
  method: SourceInstallationMethod | undefined,
  scope: "project" | "user-global",
): void {
  const skillName = path.posix.basename(selection.path);
  const canonicalPath = path.join(projectRoot, ".agents", "skills", skillName);
  const claudePath = path.join(projectRoot, ".claude", "skills", skillName);
  output(`Preview: reconcile Skill ${JSON.stringify(skillName)} from ${source.id} (destination determined by safe inspection)`);
  output(`  scope: ${scope}; hosts: ${selection.hosts.join(",")}; version policy: ${formatVersionPolicy(selection.version)}`);
  output("  intended filesystem changes:");
  output("    reconcile the selected source files below: adopt identical files, create missing files, and refuse conflicts");
  output("  selected source files:");
  for (const file of files) {
    output(`    ${file.path} (${file.content.byteLength} bytes${file.executable ? ", executable" : ""}; adopt if identical, create if missing)`);
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

function formatVersionPolicy(version: VersionPolicy): string {
  return version.policy === "latest" ? "latest" : `fixed:${version.version}`;
}

function selectionWithInstallation(
  selection: ProjectSkillSelection,
  result: ProjectSkillInstallationResult,
  projectRoot: string,
): ProjectSkillSelection {
  return parseProjectManifest({
    version: 1,
    skills: [{
      ...selection,
      installation: {
        path: relativeProjectPath(projectRoot, result.canonicalPath),
        adopted: result.adopted,
      },
    }],
  }).skills[0]!;
}

function relativeProjectPath(projectRoot: string, candidate: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Installed Skill location escapes the project root: ${candidate}`);
  }
  return relative.split(path.sep).join("/");
}

function outputInstallationResult(
  result: ProjectSkillInstallationResult,
  projectRoot: string,
  output: (line: string) => void,
): void {
  const locations = result.adopted
    ? result.adoptedPaths
    : [result.canonicalPath];
  const rendered = locations.map((location) => relativeProjectPath(projectRoot, location)).join(", ");
  output(`${result.adopted ? "Adopted" : "Installed"} Skill ${JSON.stringify(result.skillName)} at ${rendered}`);
}

async function installOne(
  selection: ProjectSkillSelection,
  source: Source,
  sourceAccess: ProjectSkillTreeAccess,
  projectRoot: string,
  dependencies: CliDependencies,
  method: SourceInstallationMethod | undefined,
  portableV1: boolean,
  files: readonly SkillTreeFile[],
  confirmAdditionalHostExposure: boolean,
): Promise<ProjectSkillInstallationTransaction> {
  return installProjectSkillTransaction({
    selection,
    source,
    previewTree: files,
    portableV1,
    confirmAdditionalHostExposure,
  }, {
    projectRoot,
    sourceAccess,
    ...dependencies.installationOptions,
  });
}

async function executeOrRejectMethod(
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

function externalMethodFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `External installation method failed after installation and manifest persistence; ` +
    `installed files were retained because method side effects cannot be rolled back: ${detail}`,
  );
}

async function rollbackTransactions(
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

function defaultProjectSkillTreeAccess(): ProjectSkillTreeAccess {
  const access = createSourceContentAccess();
  if (!access.readSkillTree) {
    throw new Error("Configured Source content access cannot read complete Skill trees");
  }
  return {
    readSkillTree: (source, skillPath) => access.readSkillTree!(source, skillPath),
  };
}

function projectSourceFromSource(source: Source, ref: string | undefined, version: VersionPolicy): ProjectSource {
  if (source.kind === "builtin") {
    if (ref !== undefined) {
      throw new CliUsageError("The built-in Source does not support --ref; its version follows the Agent Depot package");
    }
    return { kind: "builtin", id: source.id };
  }
  const selectedRef = ref ?? (version.policy === "fixed" ? version.version : source.ref);
  return { kind: "external", url: source.url, ...(selectedRef === undefined ? {} : { ref: selectedRef }) };
}

function requireConfirmation(confirmed: boolean, message: string): void {
  if (!confirmed) {
    throw new CliUsageError(message);
  }
}

function formatSource(source: Source): string {
  if (source.kind === "builtin") {
    return `${source.id}\tbuiltin\t${source.name}\tread-only`;
  }
  return `${source.id}\tgit\t${source.url}`;
}

function formatCandidate(candidate: SkillCandidate): string {
  const description = candidate.description.replace(/[\r\n]+/gu, "\\n");
  return `Candidate: ${candidate.sourceId}\t${candidate.path}\t${candidate.name}\t${description}`;
}

function formatDiscoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown discovery error";
  if (error instanceof SourceNotFoundError) {
    return `${message}. Run \`agent-depot source list\` and pass a registered Source ID`;
  }
  if (message.startsWith("Git Source mirror is not available:")) {
    return `${message}. Refresh the selected Git Source with \`agent-depot source refresh <source-id> --yes\` before discovering`;
  }
  return message;
}

async function findSource(operations: SourceOperations, sourceId: string): Promise<Source> {
  const source = (await operations.listSources()).find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new SourceNotFoundError(sourceId);
  }
  return source;
}

function requireArgumentCount(values: readonly string[], expected: number, usage: string): void {
  if (values.length !== expected) {
    throw new CliUsageError(`Usage: agent-depot ${usage}`);
  }
}

function requireSourceIds(sourceIds: readonly string[]): void {
  if (sourceIds.length === 0) {
    throw new CliUsageError(DISCOVER_USAGE);
  }
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
