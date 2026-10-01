import { APP_GITHUB_PATTERN, APP_NPM_PATTERN, APP_SKILL_PATTERN } from "./app-recipes.js";
import { PROJECT_HOSTS } from "./project-manifest.js";

const argv = {
  type: "array", minItems: 1, items: { type: "string", minLength: 1 },
  description: "Bare no-shell executable and arguments; user-method safety rules also apply.",
};
const text = { type: "string", minLength: 1 };
const step = {
  type: "object", additionalProperties: false,
  properties: { argv, manual: text },
  anyOf: [{ required: ["argv"] }, { required: ["manual"] }],
};
const version = {
  type: "object", additionalProperties: false, required: ["argv", "pattern"],
  properties: {
    argv, pattern: { ...text, description: "Valid JavaScript regex with exactly one capture group." },
  },
};
const hosts = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(PROJECT_HOSTS.map((host) => [host, step])),
};

export const APP_RECIPE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Agent Depot App recipe", type: "object", additionalProperties: false,
  required: ["name", "install", "update", "uninstall", "version"],
  properties: {
    name: text, platform: { enum: ["linux", "windows", "darwin"] }, homepage: text,
    install: step, update: step, uninstall: step, version,
    latest: {
      oneOf: [
        version,
        {
          type: "object", additionalProperties: false, required: ["github"],
          properties: { github: { ...text, pattern: APP_GITHUB_PATTERN } },
        },
        {
          type: "object", additionalProperties: false, required: ["npm"],
          properties: { npm: { ...text, pattern: APP_NPM_PATTERN, maxLength: 214, not: { enum: ["node_modules", "favicon.ico"] } } },
        },
      ],
    },
    setup: hosts, teardown: hosts, skills: { type: "array", items: { ...text, pattern: APP_SKILL_PATTERN } },
  },
};
