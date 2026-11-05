# J001 r1 — Diagnose absent managed Skill recovery

## Identity and authorization
Operator requested coordinator help with Agent Depot and reiterated “ya pero me ayudas con el problema de agent-depot?”. Authorized bounded read-only diagnosis; no installation, global configuration changes, real-state mutation, Git commits, remote writes, or nested delegation. Coordinator owns plan and brief. One researcher call, no retries, no corrections, approximately 15 minutes; stop with partial evidence if blocked. No added paid service or tooling.

## Objective and observations
Windows user has builtin:agent-depot skills agent-depot-apprecipe, doctor-md-agents, doctor-md-skill recorded for Pi 0.6.4. PowerShell cannot find ~/.agents/skills/<name>. Installations -> select -> i -> Claude -> confirm fails “tracked Skill installation does not exist; no path was changed”. Uninstall also fails; Catalog hides them as already installed; update preview fails ENOENT. Sources builtin is fixed/nonselectable.

## Inputs and scope
Repository C:/0-BackupVF/WorkSpace/agent-depot, code base 4f535c8274a36bd7f2c3315db6e102f10b1c995b. Live coordinator-authored uncommitted brief supplied explicitly, not a claimed Git-pinned checkpoint. Read current source at this base; disclose drift. Read AGENTS.md, docs/agents/domain.md, CONTEXT.md, relevant docs/adr (especially removal/shared locations), docs/agents/issue-tracker.md and triage-labels.md. Do not publish issues.
Trusted factory root C:/0-BackupVF/WorkSpace/isSWF. Read .agents/roles/researcher.md; selected diagnosis method .agents/skills/isswf-debug/SKILL.md and .agents/roles/references/bug-diagnosis.md under that root. Report required resources consumed/missing, self-reported unless trace observed.
Grounding: src/tui/catalog-installs.ts:isInstalled uses records; src/project-installation.ts throws missing-installation for removal/exposure. Inspect full call paths and existing tests rather than assuming Windows-specific cause.

## Acceptance and checks
Return causal evidence with exact paths/symbols/lines for Catalog filtering, adding Claude, removal, update preview and installed-state persistence. Distinguish confirmed code facts from operator reports and untested hypotheses. Recommend smallest safe repair and whether forgetting an absent record, reinstalling from source, or another existing supported command can unblock operator. Assess malformed paths, ancestor symlinks, dangling Claude link, other hosts, source absence and reappearance between preview/confirm. Identify existing test helpers and isolated-env seams; any later state-writing tests must load tests/isolated-env.ts and inject all state paths. Do not read actual user installation records or credentials. Read-only tools only; no reproduction claims without execution.

## Quality and verification
Correctness: observed deadlock, no executed regression yet. Safety: removal/links/shared-host semantics require careful preview and revalidation. Tests: inspect existing helpers, recommend focused cases. Maintainability: prefer shared write-flow core per ADR over TUI-only bypass. Compatibility: Windows-native report; distinguish portable missing-file issue from actual Windows link restrictions. Independent candidate review required for later state-mutating repair; this task produces no candidate. Coordinator will reconcile scope before writer dispatch.

## Return
Use supported output routing; no repository edits. Return diagnosis, safe immediate workaround only if source-verified, proposed repair scope, risks, regression seams and unknowns. Requested/effective role isswf-researcher openai/gpt-6-luna high. No commits/push/PR, installation or real user-state modifications. Stop after diagnosis.
