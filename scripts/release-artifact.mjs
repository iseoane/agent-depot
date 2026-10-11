#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@iseoane/agent-depot";
const stableSemVer = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function readTarballManifest(tarball) {
  return JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
}

function readPackReport(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const entries = Array.isArray(report) ? report : Object.values(report);
  assert.equal(entries.length, 1, "npm pack must report exactly one package");
  return entries[0];
}

function validateIdentity({ version, sourceSha, packageManifest, tarballManifest, packReport }) {
  assert.match(version, stableSemVer, "release version must be stable SemVer without a v prefix");
  assert.match(sourceSha, /^[0-9a-f]{40}$/u, "source SHA must be a full Git commit SHA");
  assert.equal(packageManifest.name, packageName);
  assert.equal(packageManifest.publishConfig?.access, "public");
  assert.equal(packageManifest.version, version, "requested version must exactly match package.json");
  assert.equal(tarballManifest.name, packageName, "tarball package name must match package.json");
  assert.equal(tarballManifest.version, version, "tarball version must match the requested version");
  assert.equal(packReport.name, packageName);
  assert.equal(packReport.version, version, "npm pack report version must match the requested version");
  const expectedFilename = `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
  assert.equal(packReport.filename, expectedFilename);
}

export function prepareReleaseArtifact({ packageRoot, version, sourceSha, packReportPath, outputPath }) {
  const packageManifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const packReport = readPackReport(packReportPath);
  const tarballPath = path.resolve(path.dirname(packReportPath), packReport.filename);
  const tarballManifest = readTarballManifest(tarballPath);
  validateIdentity({ version, sourceSha, packageManifest, tarballManifest, packReport });

  const tarball = readFileSync(tarballPath);
  const sha512 = createHash("sha512").update(tarball).digest("base64");
  const integrity = `sha512-${sha512}`;
  assert.equal(packReport.integrity, integrity, "npm pack integrity must match the tarball bytes");

  const artifact = {
    name: packageName,
    version,
    sourceSha,
    filename: packReport.filename,
    sha256: createHash("sha256").update(tarball).digest("hex"),
    integrity,
  };
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

export function checkRegistryVersion({ registryMetadata, artifact, expectedVersion, expectedSourceSha, published }) {
  assert.equal(artifact.name, packageName, "artifact package name must match the package");
  assert.equal(artifact.version, expectedVersion, "artifact version must match the requested version");
  assert.equal(artifact.sourceSha, expectedSourceSha, "artifact must come from the checked-out commit");
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/u, "artifact must include a SHA-256 digest");
  assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u, "artifact must include an SRI SHA-512 digest");

  assert.ok(registryMetadata && typeof registryMetadata === "object", "npm registry response must be a JSON object");
  assert.ok(registryMetadata.versions && typeof registryMetadata.versions === "object", "npm registry response must include package versions");
  const publishedVersion = registryMetadata.versions[expectedVersion];
  if (!published) {
    assert.equal(publishedVersion, undefined, `${packageName}@${expectedVersion} already exists on npm`);
    return "available";
  }

  assert.ok(publishedVersion, `${packageName}@${expectedVersion} is not visible on npm yet`);
  assert.equal(publishedVersion.name, packageName, "registry package name must match");
  assert.equal(publishedVersion.version, expectedVersion, "registry version must match");
  assert.equal(publishedVersion.dist?.integrity, artifact.integrity, "published integrity does not match the validated tarball");
  assert.equal(registryMetadata["dist-tags"]?.latest, expectedVersion, "npm latest tag does not point to the requested version");
  return "published";
}

function argsFrom(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    assert.match(key, /^--[a-z-]+$/u, `unexpected argument: ${key}`);
    assert.ok(argv[index + 1], `missing value for ${key}`);
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

function main(argv) {
  const [command, ...rest] = argv;
  const args = argsFrom(rest);
  if (command === "prepare") {
    const artifact = prepareReleaseArtifact({
      packageRoot: args.root,
      version: args.version,
      sourceSha: args["source-sha"],
      packReportPath: args.report,
      outputPath: args.output,
    });
    console.log(`Validated ${artifact.name}@${artifact.version} from ${artifact.sourceSha}`);
    return;
  }

  if (command === "check-registry") {
    const artifact = JSON.parse(readFileSync(args.artifact, "utf8"));
    const metadata = JSON.parse(readFileSync(args.metadata, "utf8"));
    const result = checkRegistryVersion({
      registryMetadata: metadata,
      artifact,
      expectedVersion: args.version,
      expectedSourceSha: args["source-sha"],
      published: args.published === "true",
    });
    console.log(result);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
