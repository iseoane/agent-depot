import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRegistryVersion, prepareReleaseArtifact } from "./release-artifact.mjs";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const version = "0.5.2";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-depot-release-"));
  const packageRoot = path.join(directory, "checkout");
  const tarRoot = path.join(directory, "package");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(tarRoot, { recursive: true });
  const manifest = { name: "@iseoane/agent-depot", version, publishConfig: { access: "public" } };
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(tarRoot, "package.json"), JSON.stringify(manifest));
  const filename = "iseoane-agent-depot-0.5.2.tgz";
  const tarballPath = path.join(directory, filename);
  execFileSync("tar", ["-czf", tarballPath, "-C", directory, "package"]);
  const bytes = readFileSync(tarballPath);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const reportPath = path.join(directory, "pack.json");
  writeFileSync(reportPath, JSON.stringify([{ name: manifest.name, version, filename, integrity }]));
  const outputPath = path.join(directory, "release-manifest.json");
  return { directory, packageRoot, reportPath, outputPath, tarballPath, manifest };
}

test("prepares an artifact only when request, package metadata, and packed bytes agree", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const artifact = prepareReleaseArtifact({
    packageRoot: data.packageRoot,
    version,
    sourceSha,
    packReportPath: data.reportPath,
    outputPath: data.outputPath,
  });
  assert.deepEqual(JSON.parse(readFileSync(data.outputPath, "utf8")), artifact);
  assert.equal(artifact.name, "@iseoane/agent-depot");
  assert.equal(artifact.version, version);
  assert.equal(artifact.sourceSha, sourceSha);
  assert.equal(artifact.filename, "iseoane-agent-depot-0.5.2.tgz");
});

test("rejects non-stable, unsafe, or mismatched release versions", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  for (const invalid of ["v0.5.2", "0.5.2-rc.1", "0.5.2; touch bad", "0.5.1", "01.5.2"]) {
    assert.throws(() => prepareReleaseArtifact({
      packageRoot: data.packageRoot,
      version: invalid,
      sourceSha,
      packReportPath: data.reportPath,
      outputPath: data.outputPath,
    }), { message: /stable SemVer|exactly match/u });
  }
});

test("rejects a tarball whose embedded identity differs from the request", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  writeFileSync(path.join(data.packageRoot, "package.json"), JSON.stringify({ ...data.manifest, version: "0.5.3" }));
  assert.throws(() => prepareReleaseArtifact({
    packageRoot: data.packageRoot,
    version,
    sourceSha,
    packReportPath: data.reportPath,
    outputPath: data.outputPath,
  }), { message: /exactly match/u });
});

test("refuses to publish an existing version and distinguishes it from absent metadata", () => {
  const artifact = {
    name: "@iseoane/agent-depot",
    version,
    sourceSha,
    sha256: "a".repeat(64),
    integrity: "sha512-" + Buffer.from("fixture").toString("base64"),
  };
  assert.equal(checkRegistryVersion({
    registryMetadata: { versions: {} }, artifact, expectedVersion: version, expectedSourceSha: sourceSha, published: false,
  }), "available");
  assert.throws(() => checkRegistryVersion({
    registryMetadata: { versions: { [version]: { version } } }, artifact,
    expectedVersion: version, expectedSourceSha: sourceSha, published: false,
  }), { message: /already exists/u });
  assert.throws(() => checkRegistryVersion({
    registryMetadata: {}, artifact, expectedVersion: version, expectedSourceSha: sourceSha, published: false,
  }), { message: /must include package versions/u });
  assert.throws(() => checkRegistryVersion({
    registryMetadata: { versions: {} }, artifact, expectedVersion: version, expectedSourceSha: sourceSha, published: true,
  }), { message: /not visible/u });
});

test("confirms published latest and exact tarball integrity", () => {
  const artifact = {
    name: "@iseoane/agent-depot",
    version,
    sourceSha,
    sha256: "a".repeat(64),
    integrity: "sha512-" + Buffer.from("fixture").toString("base64"),
  };
  const registryMetadata = {
    versions: { [version]: { name: artifact.name, version, dist: { integrity: artifact.integrity } } },
    "dist-tags": { latest: version },
  };
  assert.equal(checkRegistryVersion({
    registryMetadata, artifact, expectedVersion: version, expectedSourceSha: sourceSha, published: true,
  }), "published");
  assert.throws(() => checkRegistryVersion({
    registryMetadata: { ...registryMetadata, "dist-tags": { latest: "0.5.1" } },
    artifact, expectedVersion: version, expectedSourceSha: sourceSha, published: true,
  }), { message: /latest tag/u });
  assert.throws(() => checkRegistryVersion({
    registryMetadata: { versions: { [version]: { ...registryMetadata.versions[version], dist: { integrity: "sha512-wrong" } } }, "dist-tags": { latest: version } },
    artifact, expectedVersion: version, expectedSourceSha: sourceSha, published: true,
  }), { message: /integrity does not match/u });
});
