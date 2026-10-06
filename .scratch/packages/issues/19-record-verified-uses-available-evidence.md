# 19: Package records can store available evidence as verified evidence

**What is wrong:** `writeSelection` writes `context.available` into `InstalledPackage.verified`. `available` is the Source snapshot's evidence, not the host observation after execution. If the host reports a different installed commit or version, the record can claim the source evidence as verified.

**User impact:** The Package record can mislead later readers about the version Agent Depot actually observed on the host.

**What ships now:** `writeSelection` takes the host observation and derives `verified` from it alone, never from the Source's available evidence. A host commit is stored as `git-commit`, normalized, and only in a form the state store reads back. A host version is stored as `manifest-version` only when it agrees with the version the Source declares, because `declaredBy` names that declaration. Any other observation leaves `verified` absent.

**Status:** ready-for-agent

- [x] Selection records derive `verified` from observed host evidence only.
- [x] Unverifiable host evidence leaves `verified` absent instead of copying available evidence.
- [x] A regression test proves a record stores the observed host commit.

## Verification

- `tests/package-flow.test.ts`: `records persist the observed host version evidence`.
- `tests/package-flow.test.ts`: `an unverifiable host observation writes no verified evidence`.
