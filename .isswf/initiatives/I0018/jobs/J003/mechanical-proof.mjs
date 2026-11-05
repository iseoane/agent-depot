import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { releaseNotes } from '../../../../../scripts/release-notes.mjs';
const base = 'e9bac638e0925278f2cf5485cee0e75323c643a0';
const head = 'affccab863325910cf86241ed6e931ecf8f29fda';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const content = (sha, file) => execFileSync('git', ['show', `${sha}:${file}`], { encoding: 'utf8' });
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('diff', '--name-only'), '');
assert.equal(git('diff', '--cached', '--name-only'), '');
assert.equal(git('diff', '--name-only', base, head), 'CHANGELOG.md\npackage.json');
const previous = JSON.parse(content(base, 'package.json'));
const current = JSON.parse(content(head, 'package.json'));
assert.equal(previous.version, '0.6.8');
assert.equal(current.version, '0.6.9');
delete previous.version;
delete current.version;
assert.deepEqual(current, previous);
assert.equal(releaseNotes(content(head, 'CHANGELOG.md'), '0.6.9'),
  releaseNotes(content(base, 'CHANGELOG.md'), 'Unreleased').replace('## [Unreleased]', '## [0.6.9] - 2026-11-04'));
assert.equal(releaseNotes(content(head, 'CHANGELOG.md'), 'Unreleased'), '## [Unreleased]\n');
assert.equal(git('diff', '--name-only', 'c7cedc6754053f21094f8e00192f969f627d6959', head, '--', 'src', 'tests', 'resources', 'skills', '.github', 'scripts'), '');
const report = { status: 'pass', base, head, files: ['CHANGELOG.md', 'package.json'],
  onlyVersionChangedInPackage: true, releaseEntryPreserved: true, reviewedRuntimeUnchanged: true };
await writeFile('.isswf/initiatives/I0018/jobs/J003/mechanical-proof.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
