---
name: review-hunting
description: Bug classes that real reviews actually found in this repo — hunt these first when reviewing allocator changes, and verify every finding adversarially before reporting.
---

# Review hunting — bug classes proven to exist in this repo

Each class below was found by review in a PR that had a green, well-written
test suite. Hunt these FIRST; they hide in the seams unit tests cannot see.
Process rule: verify every finding adversarially (try to REFUTE it by
executing the real code with the claimed failing input) before reporting —
about a third of plausible findings die under verification.

## 1. Mixed snapshots (the wiring, not the functions)

Targets computed from one read batch (pinned block) fed into a stage that
compares them against a DIFFERENT read batch (`latest`). Every function is
individually correct; the bug is which arguments `main()` passes. With a
zero threshold gate, dust-level drift between batches fabricates actions on
zero-delta legs; a lagging load-balanced RPC or reorg fabricates a wrong
deallocate. Hunt: trace every value from its `readContract` call to its
consumer; flag any expression mixing values from two batches.

## 2. Budget conservation under clamps

A pooled formula (common utilization u* = ΣB/(ΣS − budget), proportional
splits, waterfilling) conserves its budget ONLY over members it actually
cuts. Any per-member clamp (`min(0, …)`, wish bound) breaks conservation:
the clamped member's weight stays in the pooled sums and pushes the others
past the budget — through a hard limit. Hunt: for every "distribute X under
constraint" loop, sum the outputs in a concrete example where one member
gets clamped; check the sum against the budget. Fix shape: iteratively drop
un-cuttable members / serve bound members and re-derive the level.

## 3. Zombie configs (valid knobs, dead bot)

Combinations that pass all individual validation but make the bot a
permanent no-op or quietly wrong: step cap < min action (every wish clamped
under the drop threshold), per-market override below a globally-validated
tolerance (per-market HOLD zone dips below SSR), lookback window shorter
than the cooldown it feeds. Hunt: for every pair of knobs that interact in a
formula, ask what happens at the degenerate ordering; a config the operator
can plausibly set must either work or refuse to start.

## 4. Silently dropped inputs

A filter (`oracle !== '0x0'`, mode dispatch, index re-map) that removes an
item from a collection the rest of the cycle treats as complete. The dropped
market is never steered AND its position vanishes from aggregate math
(sleeve, budgets) — double damage, zero errors. Hunt: every `.filter()` on
the market table; ask "what happens to a filtered-out row's MONEY".

## 5. Float boundary tests that test nothing

A spec boundary (`>=` at 2/3 × SSR_t) probed with a hand-typed literal
(`0.0251333`) instead of the SAME expression production uses
(`(2/3) * (0.0352 + 25/10000)`) differs by ULPs — the test passes on both
sides of the operator choice. Rules: derive test thresholds with the exact
production expression (bit-for-bit), probe exactly AT each boundary and one
step beside it, and verify round-trips (`0.9 * (x / 0.9) === x`) in a scratch
script before relying on them.

## 6. Docs/env drift

`.env.example`, the parameter tables in `docs/`, and README constraints go
stale the moment a validation or default changes — reviewers and operators
read those, not the parser. Hunt: diff every constraint stated in docs
against the actual parse/validation code (values, REQUIRED-ness, cross-field
rules). Also the reverse: comments in UNCHANGED files describing behavior
the PR just changed (e.g. an interface field comment naming semantics that
no longer exist).

## 7. Tests that pin yesterday's behavior

After a strategy change, old tests that still pass are either (a) genuinely
unaffected or (b) pinning counter-spec behavior that survived the rewrite.
Hunt: for every spec rule the PR changes, find the old test that pinned the
OLD rule and confirm it was rewritten, not merely still green.
