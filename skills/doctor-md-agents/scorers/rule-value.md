# Scorer: rule value — keep, improve or drop

Every rule is paid for on every single prompt, whether or not it ever applies. The verdict answers one question: **is this rule worth its place in the budget?**

Inputs per rule: `est_tokens`, `applicable_sessions` (adherence pass), adherence label, `corrections` (hard pass), and the rule's own text.

## Verdicts

| Verdict | When |
|---|---|
| `keep` | Evidence that it applies and is obeyed, or it is cheap and encodes something the agent cannot derive from the repo (a credential location, a user preference, a hard prohibition). |
| `improve` | It applies but is not working — adherence `mixed` or `violated`, or corrections on its subject despite the rule existing. Also when it is correct but oversized, vague, or buried where nothing reads it. |
| `drop` | Either (a) expensive *and* evidence-free *and* derivable from the repo or already enforced by tooling — all three, not any one; or (b) corroborated `harm` or `irrelevant` evidence in **2 or more distinct sessions**. |
| `unknown` | Not enough signal either way. The honest default — use it freely. |

## Rules for the verdicts themselves

**Low adherence is never a reason to drop.** A rule the agent keeps breaking is a rule that is not working, which argues for rewriting it, shortening it, moving it earlier, or replacing prose with a literal command. Dropping it removes the intent along with the failure.

**The evidence class is the gate, and it is mechanical.** Only `harm` and `irrelevant` findings can support a `drop`; `non-compliance` never can, however many there are. A hundred violations of a rule the transcripts show to be right is the strongest possible case for `improve`. Check the class before writing the verdict — a `drop` resting on `non-compliance` evidence is a bug in the report, not a judgement call.

**Unverified evidence does not exist.** A finding whose quote failed verification was discarded before scoring; it cannot appear in a rationale and cannot be counted toward the two-session bar. If a rule's entire case was discarded, its verdict is `unknown`.

**`insufficient_evidence` is not "unused".** The adherence sample is a couple of dozen sessions. Evidence-free means the sample could not see it; combined with high cost, that makes it a *candidate* for review, not a delete.

**`drop` needs a cost argument.** State the tokens. A 40-token rule that never fires is noise; a 1,500-token section that never fires is the finding.

**Prefer the rollup.** Rank by `est_tokens` × absence of evidence and lead with the aggregate: "these N rules are X% of the file and no sampled session could judge any of them." That is a decision the user can act on. A per-rule quality opinion is not.

**Redundancy counts against a rule.** A rule that restates what the repo already makes obvious — a version table duplicating a lockfile, a structure description duplicating the directory tree — is paying rent for information the agent can read on demand. Say what makes it redundant. An index that tells the agent *where* to look is not redundant; it is the cheap version of the thing it points at.

**Size is a defect of its own.** A rule too long to hold in mind while working is one the agent will follow selectively. Flag rules over ~2000 characters as `improve` with "split or compress" even when adherence looks fine.

## Proposed edits

For every `improve`, write the full replacement text, changing only what the evidence justifies. Fix the part that actually failed:

- Corrections on its subject → make it concrete. Replace description with the exact command, path or phrasing the user kept asking for.
- Buried or late in the file → say where it should move and why.
- Oversized → split into the part that is always needed and the part that can live in a referenced file.
- Vague ("be careful with X") → name the observable behaviour.

Do not rewrite a rule's intent, do not add rules the evidence did not ask for, and do not smooth the user's voice into generic guidance. Their file, their register.

## Missing rules

A missing-rule candidate needs a cluster of **2 or more** corrections, across different sessions, that no existing rule covers. One occurrence is an anecdote — list it as such if it is interesting, but do not propose a rule from it.

Write the proposal in the file's existing style and register, place it in the section it belongs to, and cite the sessions. Prefer the smallest rule that would have prevented every correction in the cluster: the cluster shows exactly what the user had to say, so the rule should say it once, up front, in their words.
