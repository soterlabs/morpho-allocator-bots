---
name: defensive-execution
description: Defensive-execution pattern for fund-moving bots — the bot may do nothing, it must never do something bad. Apply when writing or changing any executor that signs transactions.
---

# Defensive execution — "may do nothing, must never do something bad"

The safe failure mode of an allocator cron is a skipped cycle: the next run
recomputes everything from scratch. Every guard therefore converts a suspect
state into **abort with no transaction (exit 1)** — never into a best-effort
trade, a default, or a partial batch. Reference implementation:
`usds-flagship/src/batch-guards.ts` + the bands checks in `allocator.ts`.

## The pattern

1. **One plan authority, re-verified at the end.** Whatever module produces
   the plan (reconciled legs, migration plan, target vector) is the single
   authority on what the cycle may move. Every downstream stage (clamps,
   liquidity caps, dust filters, budget scaling) may only SHRINK plan legs.
   Just before signing, a **pure, unit-tested guard module** re-verifies the
   FINAL call list against the plan: same direction, amount ≤ leg, amount ≤
   current position, amount ≤ per-cycle step cap, one call per market,
   positive amounts, known indices. This catches wiring bugs that live
   between tested modules — the class unit tests structurally cannot see.

2. **Global invariant on the post-batch state, with a monotone rule for
   drift.** Compute the post-batch aggregate (sleeve, exposure, whatever the
   hard limit governs) from the FINAL amounts on the SAME snapshot the plan
   used. Inside the allowed band → must stay inside. Already outside (drift,
   interest accrual) → the batch may only move it TOWARD the band, never
   further away. Without the monotone rule the guard would block the very
   batch that fixes the drift.

3. **Completeness check.** Compare the on-chain truth of total holdings
   (e.g. `adapter.realAssets`) against the sum of positions the config can
   see, on the same pinned block, within a dust tolerance. A mismatch means
   an invisible position (wrong oracle address, missing market row) — all
   aggregate math is silently wrong. Abort.

4. **Sanity bounds on every external read, anchored to physical limits.**
   Not "reasonable-looking" bounds — bounds derived from what the chain can
   actually produce (e.g. the Adaptive Curve IRM hard-caps rateAtTarget at
   200% APR ≈ 639% APY, so anchor > 1000% APY is a corrupted read, not a hot
   market; sUSDS SSR outside [1%, 15%] is a broken read). Leave slack above
   the physical ceiling so a legitimate extreme never trips the guard, and
   pin that with a test ("still decides at the IRM ceiling").

5. **Snapshot integrity.** All plan inputs read at one pinned block; the
   SAME pinned values feed every downstream computation (mixing pinned and
   `latest` reads lets drift fabricate or resize actions). Right before
   signing, re-fetch the pinned block by number and compare hashes — a reorg
   means the plan describes a chain that no longer exists.

6. **Config that passes validation must be able to act.** Cross-validate
   knob combinations that individually look fine but jointly make the bot a
   permanent silent no-op (e.g. step cap < min action ⇒ every wish is
   clamped under the drop threshold forever). A zombie bot that exits 0
   every cycle is masked misconfiguration — refuse to start.

## What NOT to guard

- On-chain reverts of an atomic batch — a revert already means "nothing
  happened"; converting it to a pre-flight abort is nice, not necessary.
- Anything whose failure mode is a HOLD (conservative no-op). Guards exist
  for states that could produce a wrong TRADE.
- Don't add guards that silently "fix" amounts. Guards throw; they never
  adjust.
