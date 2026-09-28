#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SkillCandidate } from "./skill-discovery.js";
import {
  BuiltInSourceError,
  createSourceOperations,
  SourceNotFoundError,
  type Source,
  type SourceOperations,
} from "./sources.js";

export interface CliDependencies {
  readonly operations?: SourceOperations;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

const USAGE = [
  "Usage:",
  "  agent-depot source list",
  "  agent-depot source add <url>",
  "  agent-depot source refresh <id> [--yes]",
  "  agent-depot discover <source-id> [source-id...]",
].join("\n");
const DISCOVER_USAGE = "Usage: agent-depot discover <source-id> [source-id...]\nSelect at least one Source ID explicitly; run `agent-depot source list` to see registered Sources";

/** Runs the CLI application and returns a process exit code. */
export async function runCli(argv: readonly string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.stdout ?? ((line: string) => console.log(line));
  const errorOutput = dependencies.stderr ?? ((line: string) => console.error(line));
  const operations = dependencies.operations ?? createSourceOperations();

  try {
    if (argv[0] === "discover") {
      const sourceIds = argv.slice(1);
      requireSourceIds(sourceIds);
      const discoverSkills = operations.discoverSkills;
      if (!discoverSkills) {
        throw new CliUsageError("Discovery is unavailable in the configured Source operations");
      }

      let candidates: readonly SkillCandidate[];
      try {
        candidates = await discoverSkills(sourceIds);
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
