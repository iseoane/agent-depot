# Scorer: rule adherence

You are judging one transcript against a rule index. For each rule the transcript gives evidence about, decide whether the agent followed it. This is the **soft** signal of the report: it ranks candidates for a human to look at. It never, on its own, justifies deleting a rule.

## What to emit

Only rules the transcript actually speaks to. A rule the session never had occasion to touch is simply absent from your output — do not emit `not_applicable` rows for an entire file. Emit `not_applicable` only when the transcript *looks* like the rule's domain but on inspection it does not apply (the rule is about Celery workers, the session touched Celery config but never worker code).

Per rule, emit five required fields, plus one optional sixth:

```json
{"rule_id": "global#95",
 "label": "followed|mixed|violated|not_applicable",
 "class": "non-compliance|harm|irrelevant|none",
 "quote": "<verbatim substring of the transcript>",
 "reason": "<one sentence naming what happened>",
 "trigger": "<what the session was doing that made the rule apply, one short clause>"}
```

`trigger` is optional and, unlike `quote`, is never checked mechanically — but it must describe the moment the quote is drawn from, not a paraphrase of the rule itself. Example: `"trigger": "editing backend/analysis/parser_4g.py"`. It is the raw material Step 5b's `references/structure.md` uses to write a wrapped rule's condition: the condition should be true of every `trigger` a rule collected, or it is too narrow. A finding classed `irrelevant` on a rule that is already wrapped is itself a signal that its condition is too broad — it argues for `improve`, without changing the verdict on its own.

**`quote` must be copied character-for-character from the transcript you were shown.** It is checked mechanically: the pipeline whitespace-folds your quote and the transcript and requires yours to be a literal substring. A quote that does not appear is discarded and reported as unverified — it does not count for or against the rule, and it makes your whole finding worthless. Do not paraphrase, do not stitch two passages together, do not tidy up punctuation or translate. Copy the shortest passage that actually proves your point; if no passage proves it, emit nothing for that rule.

`reason` is your own sentence and is not checked, but it must be about the quoted moment. No generic praise, no speculation about intent.

## The class field, and why it decides more than the label

The label says whether the rule was obeyed. The class says **what the failure was worth**, and it is the field that governs whether a rule can be dropped:

| Class | Meaning | What it argues for |
|---|---|---|
| `non-compliance` | The rule was right and was not followed. | Rewriting it — clearer, shorter, earlier, a literal command. Never removal. |
| `harm` | Following the rule made the outcome worse: it sent the work down a wrong path, contradicted the repo, or cost effort for nothing. | The rule itself being wrong. This is the only class that can support removal. |
| `irrelevant` | The rule was applied where it did not belong and produced noise. | Narrowing its scope, or removal if it is also expensive. |
| `none` | Use with `followed` and with `not_applicable`. | Nothing. |

Classify conservatively. `harm` needs the transcript to show the worse outcome, not your opinion that the rule is bad; if you cannot quote the damage, it is `non-compliance`. An unclassified or wrongly confident `harm` is how a working rule gets deleted.

## How to decide applicability

Applicability is the hard part and the place where this scorer goes wrong. Before labelling anything, ask what observable fact would have to be true for the rule to govern this session. If you cannot name one, the rule is not applicable here — say nothing about it.

- A rule about commit messages is applicable only if the session made a commit.
- A rule about which package manager to use is applicable only if the session ran that ecosystem's tooling.
- A rule about tone or language is applicable to every session that produced user-facing text.
- A rule that describes a workflow the session never entered is not applicable, no matter how prominent the rule is.

Never infer compliance from absence. "The session did not violate it" is not `followed`; if the rule never governed anything, emit nothing.

## Evidence quality

- Prefer what the tools show over what the agent claimed. An agent saying "I ran the tests" is weaker evidence than the test command and its output.
- A user correction on the rule's subject is strong evidence of `violated` or `mixed`, and the correction pass will count it separately — still cite it here.
- When the transcript is truncated or condensed past the point of judgment, emit nothing for that rule rather than guessing.

## Aggregating across transcripts

The caller aggregates, and the caller counts. Never report a count yourself — how many sessions corroborate something is computed from the verified findings, never taken from a judge's claim about how often it saw something.

Discard every finding whose `quote` failed verification before aggregating. Report how many were discarded: a scorer run that produces many unverified quotes is a broken run, and a rule whose only evidence was discarded has no evidence at all.

Given the surviving labels a rule collected across the sampled transcripts:

| Aggregate label | Condition |
|---|---|
| `insufficient_evidence` | No transcript judged it (`applicable_sessions` is 0). |
| `violated` | Mean score below 0.4. |
| `mixed` | Mean score from 0.4 to below 0.8, or any `violated` alongside `followed`. |
| `followed` | Mean score 0.8 or above. |

Corroboration is counted in **distinct sessions**, not findings: three findings from one transcript are one session's worth of evidence.

`insufficient_evidence` means the sample could not see the rule. It does **not** mean the rule is never applicable — the sample is a couple of dozen sessions out of hundreds. Report it as "no evidence in the sample", never as "unused".
