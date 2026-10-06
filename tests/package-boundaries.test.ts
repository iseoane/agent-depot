import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

/**
 * The canonical Skill constraint is enforced by absence: no `package-*` module
 * may reach `project-installation.ts` or the Skill install engine, directly or
 * through another module. A direct-edge check cannot see the second hop, so this
 * walks the whole import graph from every `package-*` module.
 */
const ENGINE = [
  "skill-install",
  "project-installation",
  "skill-removal",
  "skill-update",
  "unmanaged-removal",
  "skill-adoption",
  "user-global-skill-inventory",
  "update-flow",
  "update-batch",
] as const;

type Graph = ReadonlyMap<string, readonly string[]>;

function importsOf(source: string): readonly string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/gu)].map((match) => match[1]!);
}

/** Module keys are Source-relative without extension, so `./x.js` resolves to `x`. */
function resolveModule(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)).replace(/\.js$/u, "");
}

async function readSourceGraph(): Promise<Graph> {
  const directory = path.resolve("src");
  const graph = new Map<string, readonly string[]>();
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), key);
      } else if (/\.tsx?$/u.test(entry.name)) {
        graph.set(key.replace(/\.tsx?$/u, ""), importsOf(await readFile(path.join(current, entry.name), "utf8")));
      }
    }
  }
  await walk(directory, "");
  return graph;
}

/** The shortest import chain from `start` to a forbidden module, or undefined. */
function forbiddenReach(graph: Graph, start: string, forbidden: ReadonlySet<string>): readonly string[] | undefined {
  const queue: { key: string; trail: readonly string[] }[] = [{ key: start, trail: [start] }];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const specifier of graph.get(current.key) ?? []) {
      const next = resolveModule(current.key, specifier);
      if (next === undefined || seen.has(next) || !graph.has(next)) {
        continue;
      }
      const trail = [...current.trail, next];
      if (forbidden.has(next)) {
        return trail;
      }
      seen.add(next);
      queue.push({ key: next, trail });
    }
  }
  return undefined;
}

test("no package module reaches the Skill install engine directly or indirectly", async () => {
  const graph = await readSourceGraph();
  const packages = [...graph.keys()].filter((key) => key.startsWith("package-"));
  assert.ok(packages.length >= 5, `found ${packages.length} package modules`);
  for (const key of packages) {
    const trail = forbiddenReach(graph, key, new Set(ENGINE));
    assert.equal(trail, undefined, trail?.join(" -> "));
  }
});

test("the graph check reports an injected indirect and direct engine edge", async () => {
  const base = await readSourceGraph();
  const withIndirect: Graph = new Map([...base,
    ["package-flow", [...(base.get("package-flow") ?? []), "./injected-helper.js"]],
    ["injected-helper", ["./skill-install.js"]],
  ]);
  assert.deepEqual(forbiddenReach(withIndirect, "package-flow", new Set(ENGINE)),
    ["package-flow", "injected-helper", "skill-install"]);

  const withDirect: Graph = new Map([...base,
    ["package-state", [...(base.get("package-state") ?? []), "./project-installation.js"]],
  ]);
  assert.deepEqual(forbiddenReach(withDirect, "package-state", new Set(ENGINE)),
    ["package-state", "project-installation"]);
});
