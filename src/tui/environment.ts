import type { AppEnvironment } from "../app-flow.js";
import { createPackageOperations, type PackageEnvironment, type PackageOperations } from "../package-flow.js";
import type { ProjectInstallationOptions, ProjectSkillTreeAccess } from "../project-installation.js";
import type { ProjectManifestStore } from "../project-manifest.js";

/** Package operations for the TUI; tests inject a fake, the default builds the real flow. */
export interface TuiPackagesEnvironment {
  readonly packages?: PackageOperations;
  /** Overrides for the default Package flow; the view's home directory is the base. */
  readonly packagesEnvironment?: PackageEnvironment;
}

/**
 * Where the TUI installs and reads installations. Every field is optional so
 * embedders and tests inject fakes; defaults mirror the CLI (real home and cwd).
 */
export interface TuiEnvironment extends TuiPackagesEnvironment {
  readonly appEnvironment?: AppEnvironment;
  readonly homeDirectory?: string;
  readonly projectRoot?: string;
  readonly sourceAccess?: ProjectSkillTreeAccess;
  readonly installationOptions?: Omit<ProjectInstallationOptions, "projectRoot" | "sourceAccess">;
  readonly projectManifestStore?: ProjectManifestStore;
}

/** The Package operations a view uses: the injected fake, or the real flow over this environment. */
export function packageOperationsOf(environment: TuiEnvironment): PackageOperations {
  return environment.packages ?? createPackageOperations({
    ...(environment.homeDirectory === undefined ? {} : { homeDirectory: environment.homeDirectory }),
    ...environment.packagesEnvironment,
  });
}
