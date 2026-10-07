import { classifyUpdate } from "../package-host-plans.js";
import {
  describeCoordinates,
  type InstalledBundleEvidence,
  type InstalledPackage,
  type PackageComponent,
  type PackageInspection,
  type PackageLifecyclePlan,
  type PackageSelection,
  type PackageVersionEvidence,
} from "../package-model.js";
import type { PackageApprovalStatus } from "../package-state.js";

/** Version evidence as a short label; `unknown` when the host or the bundle states none. */
export function packageVersionLabel(evidence: PackageVersionEvidence | undefined): string {
  if (evidence === undefined) return "unknown";
  return evidence.kind === "manifest-version" ? evidence.version : evidence.commit.slice(0, 7);
}

/** What the host reports about an install, as one phrase. Never a guess. */
export function installedEvidenceLabel(evidence: InstalledBundleEvidence): string {
  switch (evidence.kind) {
    case "installed": {
      if (evidence.reason !== undefined) {
        const reason = evidence.reason.includes("local modifications") ? "local changes" : evidence.reason;
        return `installed (version unavailable: ${reason})`;
      }
      if (evidence.version !== undefined) return `installed ${evidence.version}`;
      if (evidence.commit !== undefined) return `installed at ${evidence.commit.slice(0, 7)}`;
      return "installed with no version evidence";
    }
    case "absent": {
      return "not installed";
    }
    case "unknown": {
      return `unknown (${evidence.reason})`;
    }
  }
}

/** The shared update vocabulary; the Updates list prints `up to date`, not `current`. */
export function packageStatusLabel(status: "unknown" | "current" | "update available"): "cannot assess" | "up to date" | "update available" {
  if (status === "current") return "up to date";
  if (status === "unknown") return "cannot assess";
  return status;
}

/** What a selection record itself remembers, for lists that do not read host evidence. */
export function recordedVersionLabel(record: InstalledPackage): string {
  if (record.verified !== undefined) return packageVersionLabel(record.verified);
  if (record.lastDelegatedCommit !== undefined) return record.lastDelegatedCommit.slice(0, 7);
  return "unknown";
}

/** One recorded Package selection plus its inspection, as the Installations view shows it. */
export interface PackageRow {
  readonly selection: PackageSelection;
  /** The bundle's manifest name, or its coordinate label while the bundle does not resolve. */
  readonly name: string;
  readonly installed: string;
  readonly available: string;
  readonly status: "unknown" | "current" | "update available";
  readonly drift?: string;
}

export function packageRow(record: InstalledPackage, inspection: PackageInspection): PackageRow {
  return {
    selection: record.selection,
    name: inspection.descriptor?.name ?? describeCoordinates(record.selection),
    installed: installedEvidenceLabel(inspection.installed),
    available: packageVersionLabel(inspection.available),
    status: classifyUpdate(
      inspection.installed,
      inspection.available,
      inspection.availableCommit,
      inspection.installedCommitIsAncestor,
    ),
    ...(inspection.drift === undefined ? {} : { drift: inspection.drift }),
  };
}

/** Host, evidence and status of one row, as the Installations line prints it. */
export function describePackageRow(row: PackageRow): string {
  const drift = row.drift === undefined ? "" : `  drift: ${row.drift}`;
  return `${row.selection.host}  ${row.installed}  available ${row.available}  ${packageStatusLabel(row.status)}${drift}`;
}

/** One component of the inventory; the executable effect and a host-only owner are called out. */
export function describePackageComponent(component: PackageComponent): string {
  const risk = component.effect === "executable" ? "  runs a host process" : "";
  const ownership = component.ownership === "host-only" ? "  host-only: Agent Depot never manages it" : "";
  const paths = component.paths.length === 0 ? "" : `  ${component.paths.join(", ")}`;
  return `${component.kind}  ${component.ownership}  ${component.effect}${risk}${ownership}${paths}`;
}

/** The preview lines of one frozen plan: origin, inventory, argv, blast radius and approval state. */
export function packagePlanLines(plan: PackageLifecyclePlan, approval: PackageApprovalStatus): string[] {
  const { descriptor, selection } = plan;
  return [
    `Environment: ${plan.environment}`,
    `Package: ${descriptor.name} (${selection.host}) ${plan.action}`,
    `Coordinates: ${describeCoordinates(selection)}`,
    `Origin: manifest ${plan.origin.manifestDigest.slice(0, 12)}${plan.origin.resolvedCommit === undefined ? "" : `  commit ${plan.origin.resolvedCommit.slice(0, 7)}`}`,
    `Available: ${packageVersionLabel(descriptor.version)}`,
    `Components (${descriptor.components.length}):`,
    ...descriptor.components.map((component) => `  ${describePackageComponent(component)}`),
    ...(plan.commands.length === 0
      ? ["This action runs no host command."]
      : plan.commands.flatMap((command, position) => [
          `Step ${position + 1} (${command.purpose}): ${JSON.stringify([command.executable, ...command.args])}`,
          `Executable: ${command.resolvedPath ?? command.executable}`,
        ])),
    `Blast radius: ${plan.affects.map(describeCoordinates).join(", ")}`,
    `Working directory: ${plan.cwd}`,
    `Approval: ${approval === "approved" ? "approved" : "needs approval"}`,
    ...plan.warnings.map((warning) => `Warning: ${warning}`),
  ];
}
