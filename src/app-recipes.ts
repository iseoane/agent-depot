import {
  parsePortableInstallationMethod, PROJECT_HOSTS, type ProjectHost,
} from "./project-manifest.js";

export interface AppStep {
  readonly argv?: readonly [string, ...string[]];
  readonly manual?: string;
}

export interface AppVersion {
  readonly argv: readonly [string, ...string[]];
  readonly pattern: string;
}

export interface AppRecipe {
  readonly name: string;
  readonly platform?: "linux" | "windows" | "darwin";
  readonly homepage?: string;
  readonly install: AppStep;
  readonly update: AppStep;
  readonly uninstall: AppStep;
  readonly version: AppVersion;
  readonly latest?: AppVersion | { readonly github: string } | { readonly npm: string };
  readonly setup?: Partial<Record<ProjectHost, AppStep>>;
  readonly teardown?: Partial<Record<ProjectHost, AppStep>>;
  readonly skills?: readonly string[];
}

function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find((key) => !keys.includes(key));
  if (unsupported !== undefined) throw new Error(`${field}.${unsupported}: unsupported recipe field`);
  return record;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}: expected non-empty text`);
  return value;
}

function argv(value: unknown, field: string): readonly [string, ...string[]] {
  return parsePortableInstallationMethod({ kind: "command", argv: value }, { label: `${field}:` }).argv;
}

function step(value: unknown, field: string): AppStep {
  const item = object(value, ["argv", "manual"], field);
  if (item.argv === undefined && item.manual === undefined) {
    throw new Error(`${field}: step needs argv or manual`);
  }
  return {
    ...(item.argv === undefined ? {} : { argv: argv(item.argv, `${field}.argv`) }),
    ...(item.manual === undefined ? {} : { manual: text(item.manual, `${field}.manual`) }),
  };
}

function version(value: unknown, field: string): AppVersion {
  const item = object(value, ["argv", "pattern"], field);
  const pattern = text(item.pattern, `${field}.pattern`);
  try {
    new RegExp(pattern);
  } catch (error) {
    throw new Error(`${field}.pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Count captures while ignoring escapes, character classes and non-capturing/lookaround groups.
  let captures = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === "[") inClass = true;
    if (pattern[i] === "]") inClass = false;
    const namedCapture = /^\?<[^=!]/u.test(pattern.slice(i + 1));
    if (!inClass && pattern[i] === "(" && (pattern[i + 1] !== "?" || namedCapture)) captures++;
  }
  if (captures !== 1) throw new Error(`${field}.pattern: expected exactly one capture group`);
  return { argv: argv(item.argv, `${field}.argv`), pattern };
}

function hosts(value: unknown, field: string): Partial<Record<ProjectHost, AppStep>> {
  return Object.fromEntries(Object.entries(object(value, PROJECT_HOSTS, field)).map(
    ([host, item]) => [host, step(item, `${field}.${host}`)],
  ));
}

function latest(value: unknown): AppRecipe["latest"] {
  const item = object(value, ["github", "npm", "argv", "pattern"], "latest");
  if (Object.keys(item).length === 1 && item.github !== undefined) {
    const github = text(item.github, "latest.github");
    if (!/^[\w.-]+\/[\w.-]+$/u.test(github)) throw new Error("latest.github: expected owner/repo");
    return { github };
  }
  if (Object.keys(item).length === 1 && item.npm !== undefined) {
    return { npm: text(item.npm, "latest.npm") };
  }
  return version(item, "latest");
}

export function parseAppRecipe(value: unknown): AppRecipe {
  const item = object(value, [
    "name", "platform", "homepage", "install", "update", "uninstall", "version",
    "latest", "setup", "teardown", "skills",
  ], "recipe");
  if (item.platform !== undefined && (
    typeof item.platform !== "string" || !["linux", "windows", "darwin"].includes(item.platform)
  )) {
    throw new Error("platform: unsupported platform");
  }
  let skills: string[] | undefined;
  if (item.skills !== undefined) {
    if (!Array.isArray(item.skills)) throw new Error("skills: expected a list");
    skills = [];
    for (const [index, skill] of item.skills.entries()) {
      skills.push(text(skill, `skills[${index}]`));
    }
  }
  return {
    name: text(item.name, "name"),
    install: step(item.install, "install"),
    update: step(item.update, "update"),
    uninstall: step(item.uninstall, "uninstall"),
    version: version(item.version, "version"),
    ...(item.platform === undefined ? {} : { platform: item.platform as AppRecipe["platform"] }),
    ...(item.homepage === undefined ? {} : { homepage: text(item.homepage, "homepage") }),
    ...(item.latest === undefined ? {} : { latest: latest(item.latest) }),
    ...(item.setup === undefined ? {} : { setup: hosts(item.setup, "setup") }),
    ...(item.teardown === undefined ? {} : { teardown: hosts(item.teardown, "teardown") }),
    ...(skills === undefined ? {} : { skills }),
  };
}
