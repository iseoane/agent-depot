import path from "node:path";

import type { SourceInstallationMethod } from "./project-manifest.js";

/** The application-level description shown before a user-provided command runs. */
export interface UserMethodPreview {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly target: string;
  readonly declaredChanges: readonly string[];
  readonly warning: string;
}

export interface UserMethodPreviewOptions {
  readonly method: SourceInstallationMethod;
  readonly projectRoot: string;
  readonly target: string;
  readonly declaredChanges: readonly string[];
}

/**
 * Produces a terminal-independent command preview. This function has no
 * process or filesystem side effects and is safe to call during assessment.
 */
export function previewUserMethod(options: UserMethodPreviewOptions): UserMethodPreview {
  return Object.freeze({
    argv: Object.freeze([...options.method.argv] as [string, ...string[]]),
    cwd: path.resolve(options.projectRoot, options.method.cwd ?? "."),
    target: options.target,
    declaredChanges: Object.freeze([...options.declaredChanges]),
    warning: "The external method may have effects Agent Depot cannot verify or roll back.",
  });
}
