import type { AppEnvironment } from "../app-flow.js";
import type { ProjectInstallationOptions, ProjectSkillTreeAccess } from "../project-installation.js";
import type { ProjectManifestStore } from "../project-manifest.js";

/**
 * Where the TUI installs and reads installations. Every field is optional so
 * embedders and tests inject fakes; defaults mirror the CLI (real home and cwd).
 */
export interface TuiEnvironment {
  readonly appEnvironment?: AppEnvironment;
  readonly homeDirectory?: string;
  readonly projectRoot?: string;
  readonly sourceAccess?: ProjectSkillTreeAccess;
  readonly installationOptions?: Omit<ProjectInstallationOptions, "projectRoot" | "sourceAccess">;
  readonly projectManifestStore?: ProjectManifestStore;
}
