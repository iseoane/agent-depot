import assert from 'node:assert/strict';
import { readFile, realpath, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const repository = await realpath('C:/0-BackupVF/WorkSpace/agent-depot');
const factory = await realpath('C:/0-BackupVF/WorkSpace/isSWF');
const gitExecutable = await realpath('C:/Program Files/Git/ucrt64/bin/git.exe');
const { invokeEvidence } = await import(pathToFileURL(path.join(factory, 'tools/git-evidence-invoke.mjs')).href);
const cli = path.join(factory, 'tools/git-evidence.mjs');
const baseSha = '2ec4b38058c87a03510c2d69424588535cc64399';
const candidateSha = 'c7cedc6754053f21094f8e00192f969f627d6959';
const paths = [
  "AGENTS.md",
  "CONTEXT.md",
  "DESIGN.md",
  "docs/agents/domain.md",
  "docs/agents/workflows.md",
  "docs/adr/0006-shared-core-module-per-write-flow.md",
  "docs/adr/0009-delegate-package-lifecycle-to-host-clis.md",
  "src/git-source.ts",
  "src/process-runner.ts",
  "src/source-snapshot.ts",
  "src/skill-discovery.ts",
  "src/sources.ts",
  "src/package-flow.ts",
  "src/package-content.ts",
  "src/package-owned-skills.ts",
  "src/package-host-state.ts",
  "src/user-global-skill-inventory.ts",
  "src/tui/catalog-state.ts",
  "src/tui/catalog-installs.ts",
  "src/tui/installations.ts",
  "src/tui/app.tsx",
  "tests/source-snapshot-batch.test.ts",
  "tests/git-source.test.ts",
  "tests/process-runner.test.ts",
  "tests/skill-discovery.test.ts",
  "tests/package-flow.test.ts",
  "tests/package-owned-skills.test.ts",
  "tests/user-global-skill-inventory.test.ts",
  "tests/tui-package-journey.test.tsx",
  "tests/tui-catalog-packages.test.tsx",
  "tests/tui-catalog-view.test.tsx",
  "tests/tui-installations-view.test.tsx",
  "tests/isolated-env.ts",
  "package.json",
  "CHANGELOG.md",
  ".github/workflows/ci.yml"
];
const common = { version: 1, repository, baseSha, candidateSha, gitExecutable, timeoutMs: 5000 };
const extensionBindings = {
  'isswf.git-evidence/1': { ...common, outputBytes: 4096 },
  'isswf.git-evidence.diff/1': { ...common, outputBytes: 131072 },
  'isswf.git-evidence.content/1': { ...common, outputBytes: 65536, paths },
};
assert.equal(execFileSync(gitExecutable, ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), candidateSha);
assert.equal(execFileSync(gitExecutable, ['-C', repository, 'diff', '--name-only'], { encoding: 'utf8' }).trim(), '');
assert.equal(execFileSync(gitExecutable, ['-C', repository, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim(), '');
assert.ok(Buffer.byteLength(JSON.stringify(extensionBindings)) < 16384);
assert.ok(paths.length <= 64);
const sourceDelta = execFileSync(gitExecutable, ['-C', repository, 'diff', '--name-only', baseSha, candidateSha], { encoding: 'utf8' }).trim();
assert.equal(sourceDelta, 'CHANGELOG.md\nsrc/git-source.ts\nsrc/process-runner.ts\nsrc/source-snapshot.ts\ntests/git-source.test.ts\ntests/source-snapshot-batch.test.ts');
const report = { repository, gitExecutable, baseSha, candidateSha, sourceDelta, operations: [], resources: [] };
for (const operation of ['identity', 'diff']) {
  const binding = extensionBindings[operation === 'identity' ? 'isswf.git-evidence/1' : 'isswf.git-evidence.diff/1'];
  const result = invokeEvidence({ cli, operation, binding });
  assert.ok(!result.isError, JSON.stringify(result.details));
  report.operations.push({ operation, status: result.details.status, patchBytes: result.details.patchBytes, patchSha256: result.details.patchSha256 });
}
for (const slot of ['base', 'candidate']) {
  for (const file of paths) {
    const result = invokeEvidence({ cli, operation: 'content', binding: extensionBindings['isswf.git-evidence.content/1'], slot, path: file });
    assert.ok(!result.isError, JSON.stringify({ slot, file, evidence: result.details }));
    const expected = slot === 'base' && ['src/source-snapshot.ts', 'tests/source-snapshot-batch.test.ts'].includes(file) ? 'absent' : 'ok';
    assert.equal(result.details.status, expected, `${slot}:${file}`);
    report.operations.push({ operation: 'content', slot, path: file, status: result.details.status, bytes: result.details.contentBytes, sha256: result.details.contentSha256 });
  }
}
const requiredResources = [
  '.agents/hosts/pi/agents/isswf-reviewer.md', '.agents/roles/reviewer.md',
  '.agents/skills/isswf-review/SKILL.md', '.agents/skills/isswf-performance/SKILL.md', '.agents/roles/references/execution-principles.md', '.agents/roles/references/review.md',
  '.agents/roles/references/review-convergence.md', '.agents/roles/references/design-principles.md',
  '.agents/roles/references/code-quality.md', '.agents/roles/references/comments.md',
  '.agents/roles/references/verification-principles.md', '.agents/skills/isswf-tdd/SKILL.md',
  '.agents/roles/references/tdd.md', '.agents/skills/isswf-writing/SKILL.md',
  '.agents/skills/isswf-writing/references/human-documents.md',
  '.agents/skills/isswf-writing/references/agent-documents.md',
];
for (const resource of requiredResources) {
  const absolute = path.join(factory, resource);
  const bytes = await readFile(absolute);
  report.resources.push({ path: absolute, readable: true, bytes: bytes.length });
}
for (const absolute of ['C:/Users/iseoane/.agents/skills/work-unit-commits/SKILL.md', 'C:/Users/iseoane/.agents/skills/cognitive-doc-design/SKILL.md']) {
  await access(absolute);
  report.resources.push({ path: absolute, readable: true });
}
const instructions = execFileSync(gitExecutable, ['-C', repository, 'show', `${candidateSha}:docs/agents/workflows.md`], { encoding: 'utf8' });
assert.ok(!instructions.includes('- Use `code-review`'));
assert.ok(instructions.includes('reviewer (`isswf-reviewer`)'));
try { await access(path.join(repository, 'REVIEW.md')); throw Error('Unexpected REVIEW.md: must supply it before review'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
report.reviewGuide = 'REVIEW.md absent';
report.status = 'pass';
await writeFile(path.join(repository, '.isswf/initiatives/I0018/jobs/J002/review-r1-bindings.json'), JSON.stringify(extensionBindings, null, 2) + '\n');
await writeFile(path.join(repository, '.isswf/initiatives/I0018/jobs/J002/preflight-review-r1.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, repository, candidateSha, paths: paths.length, operations: report.operations.length, resources: report.resources.length, reviewGuide: report.reviewGuide, diff: report.operations[1] }, null, 2));
