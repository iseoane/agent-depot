import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_RECIPE_SCHEMA } from "../src/app-schema.js";
import { PROJECT_HOSTS } from "../src/project-manifest.js";
import { parseAppRecipe } from "../src/app-recipes.js";
export const recipe = {
  name: "example",
  install: { argv: ["npm", "install", "-g", "example"] },
  update: { manual: "update it" },
  uninstall: {
    argv: ["example", "remove"],
    manual: "remove it"
  },
  version: {
    argv: ["example", "--version"],
    pattern: "(\\d+\\.\\d+\\.\\d+)"
  },
};

test("recipes accept command, manual and combined steps and reject unsafe argv", () => {
  assert.equal(parseAppRecipe(recipe).name, "example");
  for (const argv of [["sh", "run"], ["npm", "--token", "secret"], ["npm", "a|b"]]) {
    assert.throws(() => parseAppRecipe({
      ...recipe,
      install: { argv }
    }));
  }
});

test("version patterns require exactly one valid capture and host maps are explicit", () => {
  for (const pattern of ["v\\d+", "(a)(b)", "("])
    assert.throws(() => parseAppRecipe({
      ...recipe,
      version: {
        ...recipe.version,
        pattern
      }
    }));
  assert.throws(() => parseAppRecipe({
    ...recipe,
    setup: { unknown: { manual: "do it" } }
  }));
  assert.throws(() => parseAppRecipe({
    ...recipe,
    latest: {
      npm: "example",
      github: "a/b"
    }
  }));
});

test("capture counting handles noncapturing, named, lookbehind, escaped and class parentheses", () => {
  for (const pattern of ["(?:a)(b)", "(?<v>\\d+)", "(?<=v)(\\d+)", "\\((\\d+)\\)", "[(](\\d+)"]) {
    assert.equal(parseAppRecipe({
      ...recipe,
      version: {
        ...recipe.version,
        pattern
      }
    }).version.pattern, pattern);
  }
  for (const pattern of ["(a)(b)", "(?:a)", "("]) {
    assert.throws(() => parseAppRecipe({
      ...recipe,
      version: {
        ...recipe.version,
        pattern
      }
    }), /version.pattern:/u);
  }
});

test("validation errors identify the failing recipe field", () => {
  assert.throws(() => parseAppRecipe({
    ...recipe,
    install: { argv: ["sh", "run"] }
  }), /install.argv:/u);
  assert.throws(() => parseAppRecipe({
    ...recipe,
    setup: { pi: { manual: "" } }
  }), /setup.pi.manual:/u);
  assert.throws(() => parseAppRecipe({
    ...recipe,
    skills: ["ok", ""]
  }), /skills\[1\]:/u);
  for (const platform of ["unknown", ["linux"]]) {
    assert.throws(() => parseAppRecipe({
      ...recipe,
      platform
    }), /platform:/u);
  }
});

test("schema and parser agree on hosts, required fields, steps and latest variants", () => {
  const schema = APP_RECIPE_SCHEMA;
  assert.deepEqual(Object.keys(schema.properties.setup.properties), [...PROJECT_HOSTS]);
  assert.deepEqual(Object.keys(schema.properties.teardown.properties), [...PROJECT_HOSTS]);
  for (const host of PROJECT_HOSTS) {
    const parsed = parseAppRecipe({
      ...recipe,
      setup: { [host]: { manual: "setup" } }
    });
    assert.equal(parsed.setup?.[host]?.manual, "setup");
  }
  assert.equal(schema.properties.setup.additionalProperties, false);
  assert.throws(() => parseAppRecipe({
    ...recipe,
    setup: { foreign: { manual: "setup" } }
  }));
  assert.deepEqual(schema.required, ["name", "install", "update", "uninstall", "version"]);
  for (const field of schema.required) {
    const incomplete: Record<string, unknown> = { ...recipe };
    delete incomplete[field];
    assert.throws(() => parseAppRecipe(incomplete));
  }
  for (const field of ["install", "update", "uninstall"] as const) {
    assert.deepEqual(Object.keys(schema.properties[field].properties), ["argv", "manual"]);
    assert.deepEqual(schema.properties[field].anyOf, [{ required: ["argv"] }, { required: ["manual"] }]);
    for (const value of [{ argv: ["example", "run"] }, { manual: "do it" }, {
      argv: ["example"],
      manual: "fallback"
    }]) {
      assert.deepEqual(parseAppRecipe({
        ...recipe,
        [field]: value
      })[field], value);
    }
    assert.throws(() => parseAppRecipe({
      ...recipe,
      [field]: {}
    }));
    assert.throws(() => parseAppRecipe({
      ...recipe,
      [field]: {
        manual: "do it",
        extra: true
      }
    }));
  }
  assert.deepEqual(schema.properties.latest.oneOf.map(variant => variant.required), [["argv", "pattern"], ["github"], ["npm"],]);
  for (const value of [{
    argv: ["example", "latest"],
    pattern: "(v1)"
  }, { github: "owner/repo" }, { npm: "example" }]) {
    assert.deepEqual(parseAppRecipe({
      ...recipe,
      latest: value
    }).latest, value);
  }
  for (const latest of [{}, {
    github: "owner/repo",
    npm: "example"
  }, {
    npm: "example",
    argv: ["example"],
    pattern: "(v1)"
  }]) {
    assert.throws(() => parseAppRecipe({
      ...recipe,
      latest
    }));
  }
});

test("latest npm accepts registry package names but rejects credentials, paths and invalid names", () => {
  for (const npm of ["example", "@scope/example", "some-package.v2", "@scope-name/tool_name"]) {
    assert.deepEqual(parseAppRecipe({ ...recipe, latest: { npm } }).latest, { npm });
  }
  for (const npm of ["../example", "@scope/../example", "@scope", "UPPER", "a b", "https://registry.npmjs.org/a", "a?token=secret", "_hidden", ".hidden", "a".repeat(215)]) {
    assert.throws(() => parseAppRecipe({ ...recipe, latest: { npm } }), /latest.npm/u, npm);
  }
});

test("latest GitHub rejects dot-prefixed owner and repository segments", () => {
  for (const github of ["./repo", "../repo", ".owner/repo", "owner/.", "owner/..", "owner/.repo"]) {
    assert.throws(() => parseAppRecipe({ ...recipe, latest: { github } }), /latest.github/u, github);
  }
  assert.deepEqual(parseAppRecipe({ ...recipe, latest: { github: "owner-name/repo.name" } }).latest,
    { github: "owner-name/repo.name" });
});
