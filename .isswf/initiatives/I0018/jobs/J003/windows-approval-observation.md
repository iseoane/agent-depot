# Draft bug: concurrent App approvals can fail with Windows EPERM rename

Publication: local draft only. Intended owner is iseoane/agent-depot (App approval/atomic-file behavior), not isSWF. No issue publication or implementation authorized by preparing this report. Before any publication, check duplicates/templates/labels and apply existing needs-triage (and bug if applicable). Duplicate search and label preflight not performed; no claim of uniqueness/readiness.

## Observation and expected result
At release metadata head affccab863325910cf86241ed6e931ecf8f29fda, Windows CI41904240933 attempt1 reports one failed test out of1197:1182pass/1fail/14skip. Test `approval receipts use canonical file identity and private atomic storage` expects both concurrent `apps.approve(entry)` calls to complete and leave exactly one JSON receipt, with no temporary siblings.

Observed stack: tests/app-flow.test.ts awaitPromise.all (index1) -> app-flow.approve -> writeFileAtomically -> rename(tempSibling, receiptTarget) rejectsEPERM. Paths are temporary CI fixture directories; no real-user approvals touched. Sanitized error: `EPERM: operation not permitted, rename '<temp>/app-approvals/<id>.json.<unique>.tmp' -> '<temp>/app-approvals/<id>.json'`.

Source/runtime/test files are byte-identical to independently reviewed PR76 and its successful WindowsCI41901664781. Mechanical proof in mechanical-proof.json verifies metadata-only delta and unchanged source/tests/scripts/CI; version alone is not evidence that the failure is impossible. Linuxcheck/pack pass at the same metadatahead.

## Scope, uncertainty and safe next probe
The actual failure is observed during concurrent writes, not established as antivirus/permissions infrastructure or a new performance regression. Exact OS handle/sharing/root cause remains unconfirmed; no deterministic local reproduction attempted because this test first creates a privilege-sensitive file symlink, which fails on this local Windows account before exercising the concurrent rename. Earlier local full-suite symlinkEPERM is a different condition and not a reproduction of this CIrename failure.

One bounded failed-job-only rerun of41904240933 on unchangedhead requested after examining stack/test/atomic writer. No source/skip/timeout/assertion change and no new model/worker; first adverse log remains .scratch/release-069-ci-windows-failed.log. If it repeats, stop publication rather than repeatedly roll CI. If it passes, report intermittence evidence, not a fixed defect or proof of root cause. Existing releaseworkflow independently verifies actual publication inputs.

Potential blast radius is simultaneous writes to one App approval receipt. Do not broaden to all atomic-state writers without investigation, enable unsafe non-atomic replacement fallback without its required lock, or remove the concurrency assertion. Existing regression seam is the concurrent approval test. Recommended future grounding: reproduce same-target parallel approval/rename under Windows with safe fixtures, distinguish sharing/replace failures, assess per-target serialization or bounded atomic retries only with preservation tests. No fix implemented here.
