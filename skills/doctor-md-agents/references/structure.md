# Structure: bare vs conditional

Claude Code wraps every instruction file in a reminder saying it "may or may not be
relevant". The more of a file that does not apply to the task at hand, the more of
all of it the model discounts, including the rules that do apply. The remedy is to
say, per rule, when it applies: an `<important if="condition">` block puts a
relevance signal next to the rule, in the same XML shape the harness itself uses.

## What stays bare

Bare means always attended. Keep bare only what governs nearly every session:

- Project identity: one sentence, what it is and what it is built with.
- The project map or rules index.
- Domain invariants: rules that must hold whatever the task, where a wrong guess
  about applicability costs more than the tokens (determinism, tenant isolation,
  data lifecycle, security boundaries). A missed invariant is a defect, so never
  gate one behind a condition just because the sample rarely saw it. The
  product's role/permission model -- who may do what, RBAC matrices, tenant
  boundaries -- is one of these security boundaries and always stays bare, like
  any other invariant. Never wrap it behind a condition such as "you are doing
  authorization work": the model needs the permission boundary attended on
  every task, not only the ones that look like they touch it.
- Cross-cutting behaviour: language, tone, attribution, commit policy.

Measured rule of thumb: `applicable_sessions / sessions_judged` of about 0.6 or
more → bare. Invariants stay bare whatever the ratio.

## What gets wrapped

Everything tied to a kind of work: a subsystem, a tool, a file type, a deployment
step, a gotcha. Lessons-learned lists are the typical case: each lesson matters in
one situation and is noise in all the others.

## Writing the condition

- Name an observable action, not a topic: "you are changing Python files in the
  backend or the IRF structure", not "backend".
- One condition per rule or per tight group. Never group unrelated rules under a
  broad condition ("you are writing code"). A broad condition is a bare rule with
  extra tokens.
- Derive it from evidence. Use the `trigger` of the rule's verified findings (what
  the session was doing when the rule applied) and the subject of the correction
  clusters attached to it. Only when a rule has no evidence, write the condition
  from the rule's own text and mark it `estimated`.
- The condition must be true in every session where the rule applies. If the
  evidence shows the rule applying outside the condition you were about to write,
  widen it or leave the rule bare.

## Never cut

The restructure moves rules. It does not delete them; deletion is Step 5's `drop`
verdict, with its own evidence bar. In particular never cut, whatever a generic
"less is more" guide says:

- Commands, even long ones or ones used rarely.
- Operational snippets that are not derivable from the code: rebuild commands,
  hash recipes, Dockerfile fixes, escaping rules.
- Gotchas and naming traps. The current code does not reveal them, which is why
  they were written down.

## Order

Bare block first (identity, map, invariants, cross-cutting), then the wrapped
blocks grouped by subsystem in the order a reader would meet them: build and run,
then data and domain, then infra and delivery -- except a heading with mixed
bare/wrapped rules, which stays in place; see below. Keep each rule's original
number or anchor in the block, so references from other files still resolve.

Subsystem grouping applies **between headings, never inside one**. A numbered or
ordered list under a single heading -- a lessons-learned list is the typical case
-- stays together, in its original order and numbering, under its original
heading: never split across subsystem groups because item 3 is about the backend
and item 7 is about infra. Wrap each item individually where it already sits;
a bare item in the same list stays bare, in place, in its original position --
never hoisted out to the shared bare block at the top. Only the item's own text
gets an `<important if>` block; the list, its order and its numbers stay intact.

The heading a wrapped rule lives under is kept as structural context: headings
are never dropped, even when every rule under them ends up wrapped. A reader (and
the model) still needs to know what subsystem a wrapped block belongs to.

This also decides where a heading itself sits. A heading whose rules are mixed
-- some bare, some wrapped -- stays in its original position relative to its
neighbours; its bare items stay bare, in place, under it. Only a heading whose
rules are *all* wrapped moves into the subsystem-ordered wrapped area below the
bare block. Do not relocate a mixed heading just because part of it got
wrapped, and do not hoist its bare items out to the shared bare block at the
top -- that would scatter one heading's rules across two places in the file.
