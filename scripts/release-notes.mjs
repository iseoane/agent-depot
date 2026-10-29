import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Returns the CHANGELOG section for one released version, from its `## [version]` heading up to
// the next `## [` heading, normalized to LF and ending in a single newline.
export function releaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) throw new Error(`CHANGELOG.md has no ${heading} section`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  return `${lines.slice(start, next < 0 ? undefined : next).join("\n").trim()}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, version, output] = process.argv.slice(2);
  if (input === undefined || version === undefined || output === undefined) {
    console.error("Usage: node scripts/release-notes.mjs <CHANGELOG.md> <version> <output>");
    process.exit(2);
  }
  try {
    writeFileSync(output, releaseNotes(readFileSync(input, "utf8"), version));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
