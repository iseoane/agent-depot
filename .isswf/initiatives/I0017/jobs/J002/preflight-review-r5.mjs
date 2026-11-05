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
const baseSha = '36aa236e515863912f12e7c1ac9a2c88a9f8d22f';
const candidateSha = '62723ef0749a324d6fccf2ab3646fb9e7174d198';
const paths = [
  'AGENTS.md', 'CONTEXT.md', 'DESIGN.md', 'docs/agents/domain.md', 'docs/agents/workflows.md',
  'docs/adr/0006-shared-core-module-per-write-flow.md', 'docs/adr/0009-delegate-package-lifecycle-to-host-clis.md',
  'src/package-bundles.ts', 'src/package-cli.ts', 'src/package-flow.ts', 'src/package-host-plans.ts',
  'src/package-model.ts', 'src/package-host-state.ts', 'src/package-state.ts', 'src/package-content.ts',
  'src/package-owned-skills.ts', 'src/app-version.ts', 'src/git-source.ts',
  'src/tui/installations-rows.tsx', 'src/tui/package-rows.ts', 'src/tui/updates-panel.tsx',
  'src/tui/updates.ts', 'src/tui/updates-model.ts', 'src/tui/updates-flow.ts', 'src/tui/package-actions.tsx',
  'tests/package-evidence.test.ts', 'tests/package-flow.test.ts', 'tests/package-bundles.test.ts',
  'tests/tui-updates-view.test.tsx', 'tests/package-host-plans.test.ts', 'tests/package-cli.test.ts',
  'tests/package-updates.test.ts', 'tests/isolated-env.ts', 'tests/fake-package-operations.ts', 'package.json', 'CHANGELOG.md', 'tests/e2e-packages.test.ts', 'tests/fixtures/packages/pstack/.claude-plugin/marketplace.json', 'tests/fixtures/packages/pstack/plugins/pstack/.claude-plugin/plugin.json', '.github/workflows/ci.yml', '.github/workflows/publish.yml', 'scripts/release-notes.mjs', 'scripts/release-artifact.mjs',
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
assert.equal(sourceDelta, 'CHANGELOG.md\npackage.json\ntests/e2e-packages.test.ts');
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
    const expected = 'ok';
    assert.equal(result.details.status, expected, `${slot}:${file}`);
    report.operations.push({ operation: 'content', slot, path: file, status: result.details.status, bytes: result.details.contentBytes, sha256: result.details.contentSha256 });
  }
}
const requiredResources = [
  '.agents/hosts/pi/agents/isswf-reviewer.md', '.agents/roles/reviewer.md',
  '.agents/skills/isswf-review/SKILL.md', '.agents/skills/isswf-e2e/SKILL.md', '.agents/skills/isswf-e2e/references/test-quality.md', '.agents/skills/isswf-e2e/references/cli-and-api.md', '.agents/roles/references/review.md',
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
await writeFile(path.join(repository, '.isswf/initiatives/I0017/jobs/J002/review-r5-bindings.json'), JSON.stringify(extensionBindings, null, 2) + '\n');
await writeFile(path.join(repository, '.isswf/initiatives/I0017/jobs/J002/preflight-review-r5.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, repository, candidateSha, paths: paths.length, operations: report.operations.length, resources: report.resources.length, reviewGuide: report.reviewGuide, diff: report.operations[1] }, null, 2));
