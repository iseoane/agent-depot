## Why the change

Catalog and Installations repeatedly started a local Git process for every Source manifest and independently reread the same immutable snapshots. This made cached, offline data loading take tens of seconds.

## Change outline

- Read eligible manifests by validated object IDs through one bounded `git cat-file --batch` per uncached Source snapshot, preserving contents, ordering, scope and exclusions.
- Share small immutable snapshots across existing Skills, Packages and ownership readers. Keys include mirror location, directory scope, resolved commit and runner identity; mirror safety and current refs are checked before every lookup.
- Bound requests, framing, output, runtime and retention; reject malformed/missing/truncated objects and evict failed work. Handle Windows stdin EOF during cancellation without losing the timeout result.
- No dependency, persisted-schema, Host-lifecycle, version or CI changes. No persistent tab view-model cache or Source refresh on view load.

### Measured data-loading improvement

Three alternating fresh-process comparisons per loader on Windows x64 / Node 26.12.1:

| Loader | Baseline median | Measured candidate median | Child processes |
| --- | ---: | ---: | ---: |
| Catalog combined loading paths | 31.749 s | 2.369 s | 450 → 27 |
| Complete Installations loader | 19.055 s | 1.885 s | 241 → 30 |

Baseline was the unchanged installed `0.6.8` release; the three-pair candidate was `cdc6ad4f4365a2d0bf4619a677d660c2ead4f019`. All pairs produced identical complete serialized outputs. Snapshot caches started empty in each process; OS caches were not flushed. HTTP was blocked, with no attempted requests or resource lifecycle operations.

The final head differs in production only by Windows pending-input EOF handling. An additional exact-head confirmation produced **2.424 s / 27 processes** and **1.870 s / 30 processes**, with the same full output hashes. These are loader timings, **not measurements of complete terminal painting**.

## Special things to note

- Immutable-content retention is limited to eight entries per runner, each at most 4 MiB of UTF-8 payload; larger snapshots are not retained. Batch limits are 4,096 files, 2 MiB per file and 32 MiB total data.
- Coalescing is best-effort while a key remains indexed. More than eight distinct pending snapshots can evict a pending key and allow redundant work; freshness and returned content remain unaffected.
- Mutable Host evidence, approvals, selections and ownership decisions are not cached. Source execution plans still perform their existing fresh safety checks.
- Independent exact-candidate review: **Standards PASS / Spec PASS**, no blockers; the cache-pressure qualification above addresses its non-blocking suggestion. Reviewer source inspection was independent; checks and measurements below were coordinator-run, not independently rerun.

## Risk assessment

**Medium.** This changes a shared Source read path and the optional-stdin process boundary used by discovery and planning. Incorrect framing, limits or cache identity could reject valid Sources, misrepresent content or repeat expensive work. Batch validation, frozen results, bounded retention, retry eviction, current-ref checks, real-Git fixtures and full actual-loader output equality mitigate these risks. No persisted configuration or Host installation state is changed by the optimization.

Failures should surface through existing Source/operation errors and affected regression tests. Recovery is reverting this code and restarting the process to clear its in-memory cache; there is no new state migration to undo. A live rollback was not exercised. Residual uncertainty includes the non-green local full-suite attempt, Node 24/Linux and Windows CI still pending, cache-pressure redundant work, and unmeasured terminal-paint latency. No merge or release is authorized by this PR.

## Testing

Exact reviewed head: `c7cedc6754053f21094f8e00192f969f627d6959`; base: `2ec4b38058c87a03510c2d69424588535cc64399`.

- `pnpm typecheck`, `pnpm lint`, `pnpm build`: **pass**.
- Isolated focused Git/source/process/discovery/Package tests: **85 pass, 8 existing platform skips, 0 fail** (93 reported).
- Four affected Catalog/Installations/Package-journey TUI test files: **59 pass, 0 skip, 0 fail**.
- New controls cover real-Git payload preservation/exclusions, batch framing and limits, concurrent reuse, externally changed refs, retry, owner isolation, eviction, large-result non-retention and pending-input timeout.
- Retained test-only behavioral RED commits precede their GREEN fixes: `0347083` → `cdc6ad4` for batch/reuse, and `d9b1686` → `c7cedc6` for Windows pending-input EOF.
- **Full local `pnpm test` was not green:** the shell reached its 240-second limit; the retained runner summary reported 1,139 tests, 1,062 pass, 45 fail and 32 skip. Failures included Windows symlink permissions, timed-frame checks and trailing file-level failures. No blanket claim that all pre-existed; no privilege changes, new skips or assertion weakening. Subsequent targeted TUI tests passed, but do not resolve unrelated failures.
- **Exact-head remote CI is pending** and remains a separate integration gate.
