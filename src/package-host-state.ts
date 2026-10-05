import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  BundleDescriptor,
  InstalledBundleEvidence,
  PackageSelection,
} from "./package-model.js";
import type { ProjectSource } from "./project-manifest.js";

/** The host state files Agent Depot reads and never writes. */
export type HostStateFileId = "pi-settings" | "claude-installed-plugins" | "claude-known-marketplaces";

/**
 * One host state file, parsed. A missing file is an empty section with
 * `present: false`. A file that exists but cannot be read or decoded carries an
 * `issue`; every lookup that section would answer degrades to `unknown`.
 */
export interface HostStateSection<T> {
  readonly id: HostStateFileId;
  readonly path: string;
  readonly present: boolean;
  readonly records: readonly T[];
  readonly issue?: string;
}

/** One `packages[]` entry of `~/.pi/agent/settings.json`, in either settings form. */
export interface PiInstallRecord {
  /** The entry's source exactly as recorded. */
  readonly source: string;
  /** The unpinned source: Pi's identity for the package (the repository URL without the ref). */
  readonly identity: string;
  /** The pinned ref, when the entry carries one. */
  readonly pin?: string;
  /** The pin when it is a hexadecimal git commit. */
  readonly commit?: string;
  /** True for the `{ source, extensions, … }` narrowing form. */
  readonly objectForm: boolean;
  /** True when the entry's shape could not be decoded; matching must degrade to unknown. */
  readonly drifted: boolean;
}

/** One entry of `~/.claude/plugins/installed_plugins.json`. */
export interface ClaudeInstallRecord {
  /** The registry key, `<plugin>@<marketplace>`. */
  readonly installId: string;
  readonly pluginName: string;
  readonly marketplace: string;
  readonly scope: string;
  readonly installPath: string;
  readonly version?: string;
  readonly commit?: string;
  /** True when the entry's shape could not be decoded; matching must degrade to unknown. */
  readonly drifted: boolean;
}

/** A marketplace source as `known_marketplaces.json` records it. */
export type ClaudeMarketplaceSource =
  | { readonly kind: "github"; readonly repo: string; readonly ref?: string }
  | { readonly kind: "url"; readonly url: string; readonly ref?: string }
  | { readonly kind: "git"; readonly url: string; readonly ref?: string }
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unknown"; readonly raw: string };

/** One entry of `~/.claude/plugins/known_marketplaces.json`. */
export interface ClaudeMarketplaceRecord {
  /** The registry key: the marketplace name its `.claude-plugin/marketplace.json` declares. */
  readonly name: string;
  readonly source: ClaudeMarketplaceSource;
  readonly installLocation: string;
  readonly lastUpdated?: string;
  readonly autoUpdate?: boolean;
}

/** The read-only view of everything the hosts own. */
export interface HostInstallView {
  readonly pi: HostStateSection<PiInstallRecord>;
  readonly claudePlugins: HostStateSection<ClaudeInstallRecord>;
  readonly claudeMarketplaces: HostStateSection<ClaudeMarketplaceRecord>;
}

export interface HostInstallViewEnvironment {
  readonly homeDirectory?: string;
  readonly readHostStateFile?: (filePath: string) => Promise<string>;
}

interface SectionParse<T> {
  readonly records?: readonly T[];
  readonly issue?: string;
}

/**
 * Reads the `packages` setting, or a bare `packages` array, into records.
 * Nothing here throws: an unknown entry shape becomes a drifted record so the
 * lookup it could affect reports `unknown` instead of a guess.
 */
export function parsePiPackagesSetting(value: unknown): readonly PiInstallRecord[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.packages)
      ? value.packages
      : undefined;
  if (entries === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(entries.map(parsePiInstallEntry));
}

/** Reads `installed_plugins.json` in its v2 (array per plugin) and v1 (one object) shapes. */
export function parseClaudePluginState(value: unknown): readonly ClaudeInstallRecord[] {
  if (!isRecord(value) || !isRecord(value.plugins)) {
    return Object.freeze([]);
  }
  const records: ClaudeInstallRecord[] = [];
  for (const [installId, raw] of Object.entries(value.plugins)) {
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      records.push(parseClaudeInstallEntry(installId, entry));
    }
  }
  return Object.freeze(records);
}

/** Reads `known_marketplaces.json`, whose keys are the marketplace names. */
export function parseClaudeMarketplaceState(value: unknown): readonly ClaudeMarketplaceRecord[] {
  if (!isRecord(value)) {
    return Object.freeze([]);
  }
  const records = Object.entries(value).map(([name, raw]) => parseClaudeMarketplaceEntry(name, raw));
  return Object.freeze(records);
}

/**
 * Reads the three host state files. A missing file is an empty section; a
 * drifted or unreadable file degrades to an `issue`, and this never throws.
 */
export async function readHostInstallView(env: HostInstallViewEnvironment = {}): Promise<HostInstallView> {
  const home = env.homeDirectory ?? homedir();
  const reader = env.readHostStateFile ?? ((filePath: string) => readFile(filePath, "utf8"));
  const [pi, claudePlugins, claudeMarketplaces] = await Promise.all([
    readSection("pi-settings", path.join(home, ".pi", "agent", "settings.json"), reader, parsePiSettingsFile),
    readSection(
      "claude-installed-plugins",
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      reader,
      parseClaudePluginsFile,
    ),
    readSection(
      "claude-known-marketplaces",
      path.join(home, ".claude", "plugins", "known_marketplaces.json"),
      reader,
      parseClaudeMarketplacesFile,
    ),
  ]);
  return Object.freeze({ pi, claudePlugins, claudeMarketplaces });
}

/**
 * What the host says about one bundle. Pi identity is the repository URL without
 * the ref; npm-shaped records never match a git bundle. Claude identity is
 * `<plugin>@<marketplace>`, and a record is attributed only when its marketplace
 * is the one bound to the selection's Source.
 */
export function findInstalledBundle(
  view: HostInstallView,
  descriptor: BundleDescriptor,
  selection: PackageSelection,
): InstalledBundleEvidence {
  if (descriptor.host !== selection.host) {
    return unknownEvidence("the bundle descriptor and the selection disagree on the host");
  }
  return selection.host === "pi"
    ? findPiInstalled(view.pi, selection)
    : findClaudeInstalled(view, descriptor, selection);
}

/**
 * The Pi install identity of a registered Source: `git:` plus the scheme-stripped
 * repository URL, without any ref. Built-in and local path Sources have none.
 */
export function piSourceIdentity(source: ProjectSource): string | undefined {
  if (source.kind === "builtin" || "path" in source) {
    return undefined;
  }
  return `git:${normalizeRepository(source.url)}`;
}

/**
 * The marketplace names the host has registered for a Source, resolved by
 * matching each record's own source against the Source URL.
 */
export function claudeMarketplaceNamesForSource(
  section: HostStateSection<ClaudeMarketplaceRecord>,
  source: ProjectSource,
): readonly string[] {
  const target = hostSourceReference(source);
  if (target === undefined) {
    return Object.freeze([]);
  }
  const names = section.records
    .filter((record) => marketplaceSourceMatches(record.source, target))
    .map((record) => record.name);
  return Object.freeze([...new Set(names)]);
}

type HostSourceReference =
  | { readonly kind: "repository"; readonly reference: string }
  | { readonly kind: "path"; readonly reference: string };

function hostSourceReference(source: ProjectSource): HostSourceReference | undefined {
  if (source.kind === "builtin") {
    return undefined;
  }
  if ("path" in source) {
    return { kind: "path", reference: path.normalize(source.path) };
  }
  return { kind: "repository", reference: normalizeRepository(source.url) };
}

function marketplaceSourceMatches(source: ClaudeMarketplaceSource, target: HostSourceReference): boolean {
  if (target.kind === "repository") {
    if (source.kind === "url" || source.kind === "git") {
      return normalizeRepository(source.url) === target.reference;
    }
    if (source.kind === "github") {
      const repository = source.repo.includes("://") ? source.repo : `github.com/${source.repo}`;
      return normalizeRepository(repository) === target.reference;
    }
    return false;
  }
  if (source.kind === "directory" || source.kind === "file") {
    return path.normalize(source.path) === target.reference;
  }
  return false;
}

function findPiInstalled(
  section: HostStateSection<PiInstallRecord>,
  selection: PackageSelection,
): InstalledBundleEvidence {
  if (section.issue !== undefined) {
    return unknownEvidence(section.issue);
  }
  const identity = piSourceIdentity(selection.source);
  if (identity === undefined) {
    return unknownEvidence("the selection's Source has no Pi install identity");
  }
  const wanted = normalizeRepository(identity);
  const match = section.records.find((record) =>
    !record.drifted && normalizeRepository(record.identity) === wanted,
  );
  if (match !== undefined) {
    return installedEvidence(undefined, match.commit);
  }
  if (section.records.some((record) => record.drifted)) {
    return unknownEvidence(`${section.path} holds an entry whose shape could not be read, so the install cannot be verified`);
  }
  return Object.freeze({ kind: "absent" });
}

function findClaudeInstalled(
  view: HostInstallView,
  descriptor: BundleDescriptor,
  selection: PackageSelection,
): InstalledBundleEvidence {
  const section = view.claudePlugins;
  if (section.issue !== undefined) {
    return unknownEvidence(section.issue);
  }
  const pluginName = selection.host === "claude" ? selection.pluginName : descriptor.name;
  const records = section.records.filter((record) => record.pluginName === pluginName);
  const names = claudeMarketplaceNamesForSource(view.claudeMarketplaces, selection.source);
  if (names.length > 0) {
    // V1 delegates user-global installs only, so a project or local record does not satisfy the selection.
    const match = records.find((record) => record.scope === "user" && names.includes(record.marketplace));
    return match === undefined
      ? Object.freeze({ kind: "absent" })
      : installedEvidence(match.version, match.commit);
  }
  if (records.some((record) => record.drifted)) {
    return unknownEvidence(`${section.path} holds an entry whose shape could not be read, so the install cannot be verified`);
  }
  if (records.length > 0) {
    const reason = view.claudeMarketplaces.issue
      ?? `no marketplace recorded in ${view.claudeMarketplaces.path} is bound to the selection's Source`;
    return unknownEvidence(reason);
  }
  return Object.freeze({ kind: "absent" });
}

function installedEvidence(version: string | undefined, commit: string | undefined): InstalledBundleEvidence {
  return Object.freeze({
    kind: "installed",
    ...(version === undefined || version === "" ? {} : { version }),
    ...(commit === undefined || commit === "" ? {} : { commit }),
  });
}

function unknownEvidence(reason: string): InstalledBundleEvidence {
  return Object.freeze({ kind: "unknown", reason });
}

async function readSection<T>(
  id: HostStateFileId,
  filePath: string,
  reader: (path: string) => Promise<string>,
  parse: (value: unknown) => SectionParse<T>,
): Promise<HostStateSection<T>> {
  let raw: string;
  try {
    raw = await reader(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return Object.freeze({ id, path: filePath, present: false, records: Object.freeze([]) });
    }
    return Object.freeze({
      id,
      path: filePath,
      present: true,
      records: Object.freeze([]),
      issue: `${filePath} could not be read (${errorReason(error)})`,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return Object.freeze({
      id,
      path: filePath,
      present: true,
      records: Object.freeze([]),
      issue: `${filePath} is not valid JSON (${errorReason(error)})`,
    });
  }

  const parsed = parse(value);
  if (parsed.issue !== undefined) {
    return Object.freeze({ id, path: filePath, present: true, records: Object.freeze([]), issue: parsed.issue });
  }
  return Object.freeze({ id, path: filePath, present: true, records: parsed.records ?? Object.freeze([]) });
}

function parsePiSettingsFile(value: unknown): SectionParse<PiInstallRecord> {
  if (!isRecord(value)) {
    return { issue: "the settings file is not a JSON object" };
  }
  if (value.packages === undefined) {
    return { records: Object.freeze([]) };
  }
  if (!Array.isArray(value.packages)) {
    return { issue: "the packages setting is not an array" };
  }
  return { records: parsePiPackagesSetting(value.packages) };
}

function parseClaudePluginsFile(value: unknown): SectionParse<ClaudeInstallRecord> {
  if (!isRecord(value)) {
    return { issue: "the installed plugins file is not a JSON object" };
  }
  if (value.plugins === undefined) {
    return { records: Object.freeze([]) };
  }
  if (!isRecord(value.plugins)) {
    return { issue: "the plugins record is not a JSON object" };
  }
  return { records: parseClaudePluginState(value) };
}

function parseClaudeMarketplacesFile(value: unknown): SectionParse<ClaudeMarketplaceRecord> {
  if (!isRecord(value)) {
    return { issue: "the known marketplaces file is not a JSON object" };
  }
  return { records: parseClaudeMarketplaceState(value) };
}

function parsePiInstallEntry(entry: unknown): PiInstallRecord {
  const source = typeof entry === "string"
    ? entry.trim()
    : isRecord(entry) && typeof entry.source === "string"
      ? entry.source.trim()
      : "";
  if (source === "") {
    return Object.freeze({ source: "", identity: "", objectForm: isRecord(entry), drifted: true });
  }
  const pinIndex = trailingPinIndex(source);
  const pin = pinIndex === undefined ? undefined : source.slice(pinIndex + 1);
  const identity = pinIndex === undefined ? source : source.slice(0, pinIndex);
  const commit = pin !== undefined && /^[0-9a-f]{7,64}$/iu.test(pin) ? pin.toLowerCase() : undefined;
  return Object.freeze({
    source,
    identity,
    ...(pin === undefined ? {} : { pin }),
    ...(commit === undefined ? {} : { commit }),
    objectForm: isRecord(entry),
    drifted: false,
  });
}

function parseClaudeInstallEntry(installId: string, entry: unknown): ClaudeInstallRecord {
  const id = parseClaudeInstallId(installId);
  if (id === undefined || !isRecord(entry) || typeof entry.scope !== "string" || typeof entry.installPath !== "string") {
    return Object.freeze({
      installId,
      pluginName: id?.pluginName ?? "",
      marketplace: id?.marketplace ?? "",
      scope: "",
      installPath: "",
      drifted: true,
    });
  }
  return Object.freeze({
    installId,
    pluginName: id.pluginName,
    marketplace: id.marketplace,
    scope: entry.scope,
    installPath: entry.installPath,
    ...(typeof entry.version === "string" ? { version: entry.version } : {}),
    ...(typeof entry.gitCommitSha === "string" ? { commit: entry.gitCommitSha } : {}),
    drifted: false,
  });
}

function parseClaudeMarketplaceEntry(name: string, raw: unknown): ClaudeMarketplaceRecord {
  const record = isRecord(raw) ? raw : undefined;
  return Object.freeze({
    name,
    source: parseClaudeMarketplaceSource(record?.source),
    installLocation: record !== undefined && typeof record.installLocation === "string" ? record.installLocation : "",
    ...(record !== undefined && typeof record.lastUpdated === "string" ? { lastUpdated: record.lastUpdated } : {}),
    ...(record !== undefined && typeof record.autoUpdate === "boolean" ? { autoUpdate: record.autoUpdate } : {}),
  });
}

function parseClaudeMarketplaceSource(value: unknown): ClaudeMarketplaceSource {
  if (!isRecord(value) || typeof value.source !== "string") {
    return { kind: "unknown", raw: JSON.stringify(value ?? null) };
  }
  const ref = typeof value.ref === "string" && value.ref !== "" ? value.ref : undefined;
  switch (value.source) {
    case "github":
      return typeof value.repo === "string" && value.repo !== ""
        ? Object.freeze({ kind: "github", repo: value.repo, ...(ref === undefined ? {} : { ref }) })
        : { kind: "unknown", raw: JSON.stringify(value) };
    case "url":
      return typeof value.url === "string" && value.url !== ""
        ? Object.freeze({ kind: "url", url: value.url, ...(ref === undefined ? {} : { ref }) })
        : { kind: "unknown", raw: JSON.stringify(value) };
    case "git":
      return typeof value.url === "string" && value.url !== ""
        ? Object.freeze({ kind: "git", url: value.url, ...(ref === undefined ? {} : { ref }) })
        : { kind: "unknown", raw: JSON.stringify(value) };
    case "directory":
      return typeof value.path === "string" && value.path !== ""
        ? Object.freeze({ kind: "directory", path: value.path })
        : { kind: "unknown", raw: JSON.stringify(value) };
    case "file":
      return typeof value.path === "string" && value.path !== ""
        ? Object.freeze({ kind: "file", path: value.path })
        : { kind: "unknown", raw: JSON.stringify(value) };
    default:
      return { kind: "unknown", raw: JSON.stringify(value) };
  }
}

function parseClaudeInstallId(installId: string): { readonly pluginName: string; readonly marketplace: string } | undefined {
  const at = installId.lastIndexOf("@");
  if (at <= 0 || at === installId.length - 1) {
    return undefined;
  }
  return { pluginName: installId.slice(0, at), marketplace: installId.slice(at + 1) };
}

/** The `@<pin>` of a Pi source string, only when it follows the last path segment. */
function trailingPinIndex(source: string): number | undefined {
  const at = source.lastIndexOf("@");
  return at > 0 && at > source.lastIndexOf("/") ? at : undefined;
}

function normalizeRepository(value: string): string {
  const scheme = value.indexOf("://");
  return (scheme >= 0 ? value.slice(scheme + 3) : value)
    .replace(/^git:/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "the host file could not be read";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
