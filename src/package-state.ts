import { chmod, mkdir, readFile, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

import { writeFileAtomically } from "./atomic-file.js";
import {
  PACKAGE_HOSTS,
  selectionKey,
  type InstalledPackage,
  type PackageCoordinates,
  type PackageSelection,
  type PackageVersionEvidence,
  type PersistedPackageState,
} from "./package-model.js";
import { PROJECT_MANIFEST_VERSION, ProjectManifestError, parseProjectManifest } from "./project-manifest.js";
import { defaultSourceStatePath } from "./source-state.js";

/** Approval answers only two ways; an unreadable receipt is never approval. */
export type PackageApprovalStatus = "approved" | "needs approval";

/** Everything the caller decides about a record. The store stamps `verifiedAt` at commit. */
export type PackageRecordInput = Omit<InstalledPackage, "verifiedAt">;

/** One keyed change applied by `reconcile`. Record sets cannot be replaced wholesale. */
export type PackageRecordChange =
  | { readonly kind: "upsert"; readonly record: PackageRecordInput }
  | { readonly kind: "drop"; readonly selection: PackageSelection };

export class PackageStateError extends Error {
  constructor(statePath: string, reason: string) {
    super(`Package state at ${JSON.stringify(statePath)} is invalid: ${reason}. The file was not modified; inspect or repair it before retrying.`);
    this.name = "PackageStateError";
  }
}

export class PackageStateLockError extends Error {
  constructor(statePath: string) {
    super(`Package state at ${JSON.stringify(statePath)} is busy; no changes were made. Retry after the other process finishes.`);
    this.name = "PackageStateLockError";
  }
}

/** Raised before any filesystem call when a digest cannot name a receipt file. */
export class PackageApprovalDigestError extends Error {
  constructor(digest: unknown) {
    super(`Approval digest ${JSON.stringify(digest)} is not a SHA-256 hex digest; no receipt was read or written.`);
    this.name = "PackageApprovalDigestError";
  }
}

const EMPTY_STATE: PersistedPackageState = Object.freeze({ version: 1, packages: Object.freeze([]) });
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const APPROVAL_DIGEST = /^[0-9a-fA-F]{64}$/u;
const SELECTION_KEYS: Readonly<Record<PackageCoordinates["host"], readonly string[]>> = {
  pi: ["host", "root", "source", "version"],
  claude: ["host", "marketplaceRoot", "pluginName", "source", "version"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character.codePointAt(0) === 0x7f);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, statePath: string): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unsupported) {
    throw new PackageStateError(statePath, `${label} contains unsupported field ${JSON.stringify(unsupported)}`);
  }
}

function nonEmptyString(value: unknown, label: string, statePath: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new PackageStateError(statePath, `${label} must be a non-empty string without surrounding whitespace`);
  }
  if (/\s/u.test(value) || containsControlCharacter(value)) {
    throw new PackageStateError(statePath, `${label} contains unsafe whitespace or control characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string, statePath: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new PackageStateError(statePath, `${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

/** A Source-relative directory in the one canonical form discovery produces. */
function sourceDirectory(value: unknown, label: string, statePath: string): string {
  if (typeof value !== "string") {
    throw new PackageStateError(statePath, `${label} must be a string`);
  }
  if (value !== "" && (value === "." || value.startsWith("./") || value.endsWith("/") || value.includes("//") || value.split("/").includes("."))) {
    throw new PackageStateError(statePath, `${label} must be the canonical Source-relative directory, "" for the Source root`);
  }
  return value;
}

function pluginName(value: unknown, label: string, statePath: string): string {
  const name = nonEmptyString(value, label, statePath);
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new PackageStateError(statePath, `${label} must be one path segment`);
  }
  return name;
}

function commitId(value: unknown, label: string, statePath: string): string {
  const candidate = nonEmptyString(value, label, statePath);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(candidate)) {
    throw new PackageStateError(statePath, `${label} must be a 40- or 64-character lowercase commit ID`);
  }
  return candidate;
}

function parseCoordinates(
  value: Record<string, unknown>,
  label: string,
  statePath: string,
): { readonly coordinates: PackageCoordinates; readonly manifestPath: string } {
  if (value.host !== "pi" && value.host !== "claude") {
    const hosts = PACKAGE_HOSTS.map((host) => JSON.stringify(host)).join(" or ");
    throw new PackageStateError(statePath, `${label}.host must be ${hosts}`);
  }
  assertKeys(value, SELECTION_KEYS[value.host], label, statePath);
  if (value.host === "pi") {
    const root = sourceDirectory(value.root, `${label}.root`, statePath);
    return {
      coordinates: Object.freeze({ host: "pi", root }),
      manifestPath: root === "" ? "package.json" : `${root}/package.json`,
    };
  }
  const marketplaceRoot = sourceDirectory(value.marketplaceRoot, `${label}.marketplaceRoot`, statePath);
  const name = pluginName(value.pluginName, `${label}.pluginName`, statePath);
  return {
    coordinates: Object.freeze({ host: "claude", marketplaceRoot, pluginName: name }),
    manifestPath: marketplaceRoot === ""
      ? ".claude-plugin/marketplace.json"
      : `${marketplaceRoot}/.claude-plugin/marketplace.json`,
  };
}

function parseVersionEvidence(value: unknown, label: string, statePath: string): PackageVersionEvidence {
  if (!isRecord(value)) {
    throw new PackageStateError(statePath, `${label} must be an object`);
  }
  if (value.kind === "manifest-version") {
    assertKeys(value, ["kind", "version", "declaredBy"], label, statePath);
    const version = nonEmptyString(value.version, `${label}.version`, statePath);
    if (value.declaredBy !== "bundle" && value.declaredBy !== "marketplace-entry") {
      throw new PackageStateError(statePath, `${label}.declaredBy must be "bundle" or "marketplace-entry"`);
    }
    return Object.freeze({ kind: "manifest-version", version, declaredBy: value.declaredBy });
  }
  if (value.kind === "git-commit") {
    assertKeys(value, ["kind", "commit"], label, statePath);
    return Object.freeze({ kind: "git-commit", commit: commitId(value.commit, `${label}.commit`, statePath) });
  }
  throw new PackageStateError(statePath, `${label}.kind must be "manifest-version" or "git-commit"`);
}

function parseSelection(value: unknown, label: string, statePath: string): PackageSelection {
  if (!isRecord(value)) {
    throw new PackageStateError(statePath, `${label} must be an object`);
  }
  const { coordinates, manifestPath } = parseCoordinates(value, label, statePath);
  try {
    // The manifest path is a probe, discarded after parsing. It reuses the one
    // parser that owns Source canonicalization, ref safety, and the pin rules,
    // and its containment rule rejects a root that escapes the Source.
    const [parsed] = parseProjectManifest(
      {
        version: PROJECT_MANIFEST_VERSION,
        skills: [{ source: value.source, path: manifestPath, version: value.version, hosts: [coordinates.host] }],
      },
      statePath,
    ).skills;
    return Object.freeze({ ...coordinates, source: parsed.source, version: parsed.version });
  } catch (error) {
    const field = coordinates.host === "pi" ? "root" : "marketplaceRoot";
    const reason = error instanceof ProjectManifestError
      ? error.reason.replace(/^skills\[0\]\.path/u, `${label}.${field}`).replace(/^skills\[0\]\./u, `${label}.`)
      : error instanceof Error ? error.message : "the selection is invalid";
    throw new PackageStateError(statePath, `${label} is invalid (${reason})`);
  }
}

function parseInstalledPackage(value: unknown, index: number, statePath: string): InstalledPackage {
  const label = `packages[${index}]`;
  if (!isRecord(value)) {
    throw new PackageStateError(statePath, `${label} must be an object`);
  }
  assertKeys(value, ["selection", "installId", "lastDelegatedCommit", "verified", "verifiedAt"], label, statePath);
  const selection = parseSelection(value.selection, `${label}.selection`, statePath);
  const installId = nonEmptyString(value.installId, `${label}.installId`, statePath);
  const lastDelegatedCommit = value.lastDelegatedCommit === undefined
    ? undefined
    : commitId(value.lastDelegatedCommit, `${label}.lastDelegatedCommit`, statePath);
  const verified = value.verified === undefined
    ? undefined
    : parseVersionEvidence(value.verified, `${label}.verified`, statePath);
  const verifiedAt = timestamp(value.verifiedAt, `${label}.verifiedAt`, statePath);
  return Object.freeze({
    selection,
    installId,
    ...(lastDelegatedCommit === undefined ? {} : { lastDelegatedCommit }),
    ...(verified === undefined ? {} : { verified }),
    verifiedAt,
  });
}

function parseState(value: unknown, statePath: string): PersistedPackageState {
  if (!isRecord(value)) {
    throw new PackageStateError(statePath, "the root value must be an object");
  }
  assertKeys(value, ["version", "packages"], "the state", statePath);
  if (value.version !== 1) {
    throw new PackageStateError(statePath, "the state version is unsupported");
  }
  if (!Array.isArray(value.packages)) {
    throw new PackageStateError(statePath, "packages must be an array");
  }

  const keys = new Set<string>();
  const packages = value.packages.map((item, index) => {
    const record = parseInstalledPackage(item, index, statePath);
    const key = selectionKey(record.selection);
    if (keys.has(key)) {
      throw new PackageStateError(statePath, `packages[${index}] duplicates another selection`);
    }
    keys.add(key);
    return record;
  });
  packages.sort((left, right) => compareKeys(selectionKey(left.selection), selectionKey(right.selection)));
  return Object.freeze({ version: 1, packages: Object.freeze(packages) });
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCoordinates(left: PackageCoordinates, right: PackageCoordinates): boolean {
  if (left.host === "pi" && right.host === "pi") {
    return left.root === right.root;
  }
  if (left.host === "claude" && right.host === "claude") {
    return left.marketplaceRoot === right.marketplaceRoot && left.pluginName === right.pluginName;
  }
  return false;
}

function applyChanges(
  state: PersistedPackageState,
  changes: readonly PackageRecordChange[],
): { readonly state: PersistedPackageState; readonly changed: boolean } {
  const verifiedAt = new Date().toISOString();
  const records = new Map(state.packages.map((record) => [selectionKey(record.selection), record]));
  let changed = false;
  for (const change of changes) {
    if (change.kind === "upsert") {
      records.set(selectionKey(change.record.selection), Object.freeze({ ...change.record, verifiedAt }));
      changed = true;
    } else if (records.delete(selectionKey(change.selection))) {
      changed = true;
    }
  }
  if (!changed) {
    return { state, changed: false };
  }
  const packages = [...records.values()];
  packages.sort((left, right) => compareKeys(selectionKey(left.selection), selectionKey(right.selection)));
  return { state: Object.freeze({ version: 1, packages: Object.freeze(packages) }), changed: true };
}

function normalizeApprovalDigest(digest: unknown): string {
  if (typeof digest !== "string" || !APPROVAL_DIGEST.test(digest)) {
    throw new PackageApprovalDigestError(digest);
  }
  return digest.toLowerCase();
}

function isApprovedReceipt(contents: string, digest: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).some((key) => key !== "version" && key !== "digest")) {
    return false;
  }
  // The stored digest must agree with the filename, so a copied or renamed
  // receipt cannot approve a declaration it never covered.
  return value.version === 1 && value.digest === digest;
}

export function defaultPackageStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.dirname(defaultSourceStatePath(environment, platform, homeDirectory));
}

/** The one writer for `packages.json` and the approval receipts beside it. */
export class PackageStateStore {
  readonly path: string;
  readonly approvalsDirectory: string;

  constructor(stateDirectory: string = defaultPackageStateDirectory()) {
    this.path = path.join(stateDirectory, "packages.json");
    this.approvalsDirectory = path.join(stateDirectory, "package-approvals");
  }

  /** Recorded selections in selection-key order. A missing file is an empty list. */
  async list(): Promise<readonly InstalledPackage[]> {
    const release = await this.acquireLock();
    try {
      return (await this.loadUnlocked()).packages;
    } finally {
      await release();
    }
  }

  async find(selection: PackageSelection): Promise<InstalledPackage | undefined> {
    const key = selectionKey(this.normalizeSelection(selection));
    return (await this.list()).find((record) => selectionKey(record.selection) === key);
  }

  /** Records whose selection carries these coordinates, for a plan's affected set. */
  async findAffected(coordinates: PackageCoordinates): Promise<readonly InstalledPackage[]> {
    return (await this.list()).filter((record) => sameCoordinates(record.selection, coordinates));
  }

  async upsert(record: PackageRecordInput): Promise<void> {
    const normalized = this.normalizeRecord(record);
    await this.update((state) => applyChanges(state, [{ kind: "upsert", record: normalized }]));
  }

  async drop(selection: PackageSelection): Promise<void> {
    const normalized = this.normalizeSelection(selection);
    await this.update((state) => applyChanges(state, [{ kind: "drop", selection: normalized }]));
  }

  /**
   * Applies keyed changes in one locked window, so a multi-record outcome commits
   * at once. The list is decided before the lock, so a concurrent writer for the
   * same selection is last-writer-wins rather than merged.
   */
  async reconcile(changes: readonly PackageRecordChange[]): Promise<void> {
    if (changes.length === 0) {
      return;
    }
    const normalized: readonly PackageRecordChange[] = changes.map((change) => change.kind === "upsert"
      ? { kind: "upsert", record: this.normalizeRecord(change.record) }
      : { kind: "drop", selection: this.normalizeSelection(change.selection) });
    await this.update((state) => applyChanges(state, normalized));
  }

  /** Writes the receipt for a digest that `packageApprovalDigest` already produced. */
  async approve(digest: string): Promise<void> {
    const approvalDigest = normalizeApprovalDigest(digest);
    const receipt = `${JSON.stringify({ version: 1, digest: approvalDigest }, null, 2)}\n`;
    await mkdir(this.approvalsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.approvalsDirectory, 0o700);
    await writeFileAtomically(path.join(this.approvalsDirectory, `${approvalDigest}.json`), receipt, { mode: 0o600 });
  }

  /** Reads a receipt. A missing, malformed, or mismatched receipt needs approval again. */
  async approvalStatus(digest: string): Promise<PackageApprovalStatus> {
    const approvalDigest = normalizeApprovalDigest(digest);
    let contents: string;
    try {
      contents = await readFile(path.join(this.approvalsDirectory, `${approvalDigest}.json`), "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return "needs approval";
      }
      throw error;
    }
    return isApprovedReceipt(contents, approvalDigest) ? "approved" : "needs approval";
  }

  private normalizeSelection(selection: PackageSelection): PackageSelection {
    // One canonical spelling per Source, so the key derived here matches the key
    // derived again when the same record is parsed back off disk.
    return parseSelection(selection, "selection", this.path);
  }

  private normalizeRecord(record: PackageRecordInput): PackageRecordInput {
    return { ...record, selection: this.normalizeSelection(record.selection) };
  }

  private async update(
    mutate: (state: PersistedPackageState) => { readonly state: PersistedPackageState; readonly changed: boolean },
  ): Promise<void> {
    const release = await this.acquireLock();
    try {
      const update = mutate(await this.loadUnlocked());
      if (!update.changed) {
        return;
      }
      await this.saveUnlocked(update.state);
    } finally {
      await release();
    }
  }

  private async loadUnlocked(): Promise<PersistedPackageState> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return EMPTY_STATE;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the JSON could not be parsed";
      throw new PackageStateError(this.path, `malformed JSON (${reason})`);
    }
    return parseState(value, this.path);
  }

  private async saveUnlocked(state: PersistedPackageState): Promise<void> {
    const normalized = parseState(state, this.path);
    await mkdir(path.dirname(this.path), { recursive: true });
    await writeFileAtomically(this.path, `${JSON.stringify(normalized, null, 2)}\n`, { allowLockedReplaceFallback: true });
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.path}.lock`;
    await mkdir(path.dirname(this.path), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      try {
        await mkdir(lockPath);
        return async () => {
          await rmdir(lockPath);
        };
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new PackageStateLockError(this.path);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
