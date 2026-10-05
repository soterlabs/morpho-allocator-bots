# Band steering (`ALLOCATION_MODE=bands`)

Rate-target allocator for the Flagship USDS vault (`usds-flagship/`).
Authoritative env parsing: `usds-flagship/src/band-config.ts`
(`parseBandConfig` — throws at startup on any missing/invalid value).
Design brief: `docs/plans/2026-10-05-rate-target-design-brief.md`.

## What it does

Instead of holding each market at a static bps target, the bot holds each
STEERED market's **current borrow rate at SSR + 60 bps** — the number
borrowers react to. SSR is read on-chain from `sUSDS.ssr()`
(`0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`; per-second rate in RAY,
`APY = (ssr / 1e27) ^ 31536000 − 1`). Each hour, per market:

1. **Target rate** `b* = SSR + RATE_MARGIN_BPS` (60; per-market override
   `RATE_MARGIN_<MARKET>_BPS`).
2. **Target utilization** `u*` = the utilization at which Morpho's Adaptive
   Curve IRM prices the market at `b*` given its current anchor
   (`rateAtTarget`), clamped into `[UTIL_MIN_BPS, UTIL_MAX_BPS]` = [80%, 95%].
   The curve is `borrow = anchor × curve(err)`, `err = (u − 0.9) / 0.1` above
   90% and `(u − 0.9) / 0.9` below, `curve = 1 + 3·err` above and
   `1 + 0.75·err` below — linear in the per-second rate, so the inverse is
   exact (`irm-curve.ts` delegates both directions to the blue-sdk's
   `AdaptiveCurveIrmLib` at zero elapsed time).
3. **Rest check**: if the market's current borrow rate is within ±10 bps of
   `b*` (SSR + 50–70 bps at the default margin), nothing happens (`R-REST`).
4. **Target position** `targetSupplyTotal = ceil(borrow / u*)`,
   `delta = target − vaultAssets`, sized through the gates below. `u*` also
   becomes that market's dynamic `maxUtilizationBps`, so the executor's
   withdrawal clamp lands drains exactly on target.

Why 90% matters: the anchor drifts as `d ln(anchor)/dt = 50/yr × err`. Above
90% it rises (×2 in ~25 days at 92%, ~50 days at 91%); below it falls 9×
slower per percentage point. **90% is the only utilization where the rate
stands still.** So a target above 90% is temporary heating: the anchor
climbs, `u*` slides back toward 90%, and the bot tops the market up from
idle as it does. A target below 90% cools it the same way, slowly.

| regime | when | what the bot does |
|---|---|---|
| `R-HEAT` | `u* ≥ 90%` — the market is cheap | holds it above the rest point; its anchor drifts up |
| `R-REST` | borrow rate within `b* ± 10 bps` | nothing |
| `R-COOL` | `u* < 90%` — the market is expensive | holds it below the rest point; its anchor drifts down |

The regime is a label for the trace; **the action is the sign of the
delta**. A COOL market whose utilization sits under its target still gets a
withdrawal, a HEAT market above its target still gets a deposit.

Two things sit outside the rate target, both **priority** wishes that
reconciliation serves before the ordinary ones. At most one market is
**PRIMARY** (PT-sUSDS today): it has no rate target and is asked to fill up
to its cap — but never under its own utilization floor — as a **priority
deposit**, served before every other deposit. And every non-RETIRED market
carries an env **cap** (`CAP_<MARKET>_USDS` / `CAP_<MARKET>_BPS`); a position
above it becomes a **priority withdrawal** back to the cap that bypasses
every steering gate. Each market emits at most one wish per cycle, chosen in
this order: priority withdrawal (cap breach) → priority deposit (PRIMARY
fill) → rate steering.

## Worked example (2026-10-05)

SSR 3.60% → `b*` = 4.20%. cbBTC/USDS sat at 92% utilization with anchor
3.26%, paying 5.3%; wstETH/USDS at 92% with anchor 3.75%, paying 6.1%.
Borrowers left above ~5%. The curve inverse puts cbBTC's target at 90.9%
and wstETH's at 90.4%: small deposits (≈ +$35k and +$30k) bring both rates to
4.2% at once, and the anchors keep drifting up slowly while the markets stay
above 90%.

## Precision (accepted)

| market (2026-10-05) | $10k = | rate precision |
|---|---|---|
| cbBTC ($3.0M supply) | 0.3 pp util | ~±30 bps |
| wstETH ($1.3M supply) | 0.7 pp util | ~±80 bps |

Above 90% a percentage point of utilization moves the rate by about
`0.3 × anchor`, so the 50 bps utilization deadband (below) is worth roughly
±50 bps of rate — wider than the ±10 bps rest band. Treat SSR + 50–70 bps as
an aim point, not a guarantee: borrower moves of ~$50k shift the rate ~50 bps
between cycles anyway, and the anchor only reacts to the time average.
Shrinks as the markets grow.

## Gates

Every deposit/withdrawal wish — a steering target or the PRIMARY fill — is
sized by the same steps, whatever chose its target:

- **cap bound**: the target is never negative, and a grow stops at
  `effectiveCap` (above it the allocate would revert). The bound never turns
  a grow into a drain — a position already above the ceiling stays put; only
  a breach of the env cap drains on cap grounds.
- **min action**: `|delta| < $10k` (`MIN_BAND_ACTION_USDS`) → `R-MINACTION`
- **direction cooldown**: grow within 24 h of a deallocate, or drain within
  24 h of an allocate (from on-chain Supply/Withdraw events,
  `onBehalf = adapter`); same-direction moves are not limited → `R-COOLDOWN`
- **step caps**: a surviving grow is clamped to `MAX_ALLOCATE_USDS`, a drain
  to `MAX_DEALLOCATE_USDS`; a larger move spreads over subsequent cycles (the
  rule is unchanged, the clamp is recorded in the reasons).

Each gate converts the computed delta into a hold carrying its rule.
Steering adds three checks of its own around the shared ones, so the order
per STEERED market is:

1. **rest**: current borrow rate within `b* ± 10 bps` → `R-REST`
2. **util deadband**: `|utilBps − u*| ≤ 50 bps` → `R-DEADBAND`
3. min action, direction cooldown (shared)
4. **monopolist share**: drain while vault share of market supply < 80% →
   `R-SHARE` (we are not the dominant supplier; draining cannot move util —
   go neutral; grows still allowed)
5. step caps (shared)

A priority withdrawal skips all of this — see below.

## Market caps

Same semantics as `bps` mode: caps live off-chain in env, and the on-chain
relative and absolute caps are read only to clamp allocations at execution
(a curator or sentinel can lower the absolute cap with no timelock, so the
env mirror may lag it). Every STEERED or PRIMARY market **must**
set at least one of an amount cap (`CAP_<MARKET>_USDS`, whole USDS) and a
share cap (`CAP_<MARKET>_BPS`, bps of totalAssets) — the bot refuses to start
otherwise, so a market's breach line is always a conscious choice. Only a
RETIRED market may have neither. For PT-sUSDS the amount side additionally
falls back to `PT_SUSDS_ABSOLUTE_CAP_USDS` (its bps-mode cap) when only
`CAP_PTSUSDS_BPS` is set. On the cycle's pinned snapshot:

- `marketCap` = the smaller of the caps set — the breach line.
- `effectiveCap = min(on-chain relative cap, marketCap) − 1 bps headroom` —
  the deposit ceiling; steering targets and the PRIMARY fill clamp to it. The
  headroom applies to the env cap too: the vault checks an allocate against
  the position *with* the interest accrued since the pinned block, so a fill
  to the exact cap it mirrors (PT-sUSDS's 5M absolute cap) would land over
  it and revert every cycle.

The on-chain relative cap only clamps deposits; it never triggers a drain.

## Priority withdrawal (cap breach)

Evaluated before any steering, for STEERED and PRIMARY markets. A position
above `marketCap` by at least `MIN_PRIORITY_WITHDRAWAL_USDS` ($50k) — or by
at least the 100 USDS dust floor when `marketCap` is 0, which drains the
market down to that floor — becomes a **priority withdrawal** back to the cap
(`R-PRIORITY-WITHDRAWAL`). A slice the pool's liquidity leaves under that
threshold is held rather than traded (same rule, no priority flag). A breach
is a policy violation, not a rate signal, so it skips every steering gate: no
rate target, no deadband, no direction cooldown, no monopolist share. Only two
things bound it: the pool's withdrawable liquidity (`supply − borrow − 5%
reserve`, the executor's own `LIQUIDITY_RESERVE_PERCENT` rule, so the plan
never promises liquidity the executor would refuse) and `MAX_DEALLOCATE_USDS`.
With no withdrawable liquidity the market holds and retries next cycle. The
withdrawal replaces the market's steering wish — one wish per market per
cycle.

RETIRED markets stay untouched even above their cap (`R-RETIRED`).

## Priority deposit (PRIMARY market)

At most one market (PT-sUSDS today, `MODE_PTSUSDS=PRIMARY`). No rate input —
the anchor plays no role. Its wish is the whole gap up to its **fill
target** as a **priority deposit** (`R-PRIORITY-DEPOSIT`), which
reconciliation serves before any other deposit:

`fillTarget = min(effectiveCap, position at PRIMARY_MIN_UTIL_PERCENT utilization)`

where the second term is the vault position at which the market's supply
would be `borrow × 100 / PRIMARY_MIN_UTIL_PERCENT` (80% → `borrow / 0.80`).
The floor makes PT track its own borrow demand (looper activity) instead of
absorbing every dollar the steered markets free: on 2026-10-05 PT held $3.42M
against $2.26M borrow (66% util), so its fill target was $2.83M and it asked
for nothing — budget freed by HEAT withdrawals stays idle inside the sleeve
and funds later COOL deposits in cbBTC / wstETH. PT grows again only as its
borrow grows.

The floor is a **deposit-time guard only**: a position above it holds
(`R-HOLD`), it is never a withdrawal trigger (PT's excess above the floor is
not drained; room appears gradually). A market with no borrow at all gets no
seed deposit — a brand-new PRIMARY market needs its first borrower before
the fill starts. The shared sizing still applies: a gap below
`MIN_BAND_ACTION_USDS` ($10k) holds (`R-MINACTION`), a grow within 24 h of a
deallocate holds (`R-COOLDOWN`), and the grow is clamped to
`MAX_ALLOCATE_USDS`. At or above the fill target the market holds (`R-HOLD`);
it withdraws only through the priority-withdrawal rule.

## Vault-level reconciliation (`reconcile.ts`)

The per-market wishes are reconciled against the sleeve limits before the
batch is built. The allocated sleeve must end the batch inside **[15%, 20%]**
of totalAssets; both limits are hard and are checked on the post-batch state.
On each side the priority wishes are served first, off the top of the budget;
the ordinary wishes share what is left:

- **deposits exceed the 20% cap** → the PRIMARY deposit is carved off the
  budget (cap headroom + same-batch withdrawals) first, up to the whole
  budget and never ranked by its spot rate; the remainder is waterfilled:
  the highest-earning markets fill first, down to a common spot supply APY —
  no dollar of the remaining budget could be moved to a better market.
  Cooling deposits are ordinary grows in this waterfill.
- **withdrawals break the 15% floor** → priority withdrawals (cap breaches)
  are served first — the PRIMARY market's ahead of the others, then the
  largest first — each up to what is left of the budget (floor headroom +
  same-batch deposits); the steering wishes then share the remainder in
  tiers keyed on `u*`, from the highest target utilization down (the hottest
  need first — with continuous targets each market is usually its own tier):
  whole tiers are served fully; the tier the budget cannot cover lands on one
  common utilization `u* = pooledBorrow / (pooledSupply − budget)`, so every
  market in it heats at the same tempo; lower tiers wait for the next cycle.

Legs below their drop threshold are then removed: `MIN_BAND_ACTION_USDS`
($10k) for a steering leg or a priority deposit,
`MIN_PRIORITY_WITHDRAWAL_USDS` ($50k) for a priority withdrawal — except that
a zero-cap withdrawal smaller than $50k passes as a whole (the controller
already sized it above the 100 USDS dust floor, and it bypasses the
executor's dust floor so the market ends holding nothing) while a floor cut
leaving only part of it is dropped. An empty batch does not fly.

A floor cut lands the plan 100 USDS **above** the floor
(`FLOOR_LANDING_MARGIN_USDS`): the executor may send an allocate slightly
under its leg (live cap below the pinned one, interest accrued since the
pinned block) while the deallocations go out in full, and a plan resting
exactly on the floor would then fail the batch guard every cycle. In bands
mode the executor sizes each allocate as the reconciled leg itself, shrunk
only by the live on-chain cap — the 1 bps headroom is applied to the cap, not
to the target the controller already headroomed.

## Market modes

| mode | behavior |
|---|---|
| `STEERED` | the rate target above; priority withdrawal above its cap |
| `PRIMARY` | no rate target: asks to fill up to `min(cap, borrow / PRIMARY_MIN_UTIL_PERCENT)` as a priority deposit, served before every other deposit; priority withdrawal above its cap. At most one market (startup throw otherwise); `bps` mode rejects it |
| `RETIRED` | the bot never touches the market — not even above its cap; caps optional |
| `SOUNDING` | recognized name; configuring it refuses to start |

| market (index) | mode env | code default (env unset) | `.env.example` |
|---|---|---|---|
| stUSDS/USDS (0) | `MODE_STUSDS` | `RETIRED` | `RETIRED` |
| cbBTC/USDS (1) | `MODE_CBBTC` | `STEERED` | `STEERED` |
| wstETH/USDS (2) | `MODE_WSTETH` | `STEERED` | `STEERED` |
| PT-sUSDS/USDS (3) | `MODE_PTSUSDS` | `STEERED` | `PRIMARY` |
| WETH/USDS (4) | `MODE_WETH` | `RETIRED` | `RETIRED` |

## Environment variables (bands mode)

Every knob below has a code default; a running deployment needs **no env
change** to pick up rate-target steering.

| variable | default | notes |
|---|---|---|
| `ALLOCATION_MODE` | **REQUIRED** | `bps` \| `bands`, no default. `bps` = static-target allocation decisions unchanged (incl. `validateTargetBpsSum`); fail-loud execution hardening is shared by both modes |
| `BOT_PAUSED` | `false` | `true` → log `paused`, exit 0 |
| `MAX_ALLOCATE_USDS` | **REQUIRED** (≥ `MIN_BAND_ACTION_USDS`) | per-market per-cycle grow step cap, whole USDS |
| `MAX_DEALLOCATE_USDS` | **REQUIRED** (≥ `MIN_BAND_ACTION_USDS` and ≥ `MIN_PRIORITY_WITHDRAWAL_USDS`) | per-market per-cycle drain step cap (in `bps` mode stays optional, `0` = no cap) |
| `CAP_<MARKET>_USDS` | **REQUIRED** (this or `_BPS`) for every STEERED/PRIMARY market (PT-sUSDS: falls back to `PT_SUSDS_ABSOLUTE_CAP_USDS` once `_BPS` is set) | cap amount, whole USDS (`CBBTC`/`WSTETH`/`WETH`/`PTSUSDS`/`STUSDS`); `0` = hold nothing, drain everything |
| `CAP_<MARKET>_BPS` | **REQUIRED** (this or `_USDS`) for every STEERED/PRIMARY market | cap as bps of totalAssets; `marketCap` = the smaller of the caps set; startup throws for a STEERED/PRIMARY market with neither; RETIRED markets need none |
| `MIN_PRIORITY_WITHDRAWAL_USDS` | `50000` | smallest priority withdrawal, whole USDS; a smaller breach waits (a zero cap drains from the 100 USDS dust floor instead) |
| `RATE_MARGIN_BPS` | `60` | target borrow rate = SSR + margin for STEERED markets |
| `RATE_MARGIN_<MARKET>_BPS` | unset | per-market override of the margin (`CBBTC`/`WSTETH`/`WETH`/`PTSUSDS`/`STUSDS`); unset = global |
| `UTIL_MIN_BPS` / `UTIL_MAX_BPS` | `8000` / `9500` | the target utilization is clamped into this range; validated `0 < min < max` |
| `PRIMARY_MIN_UTIL_PERCENT` | `80` | a PRIMARY fill never pushes that market's utilization under this percent (fill target `min(cap, borrow × 100 / this)`); validated in [1, 100] |
| `SSR_T_MARGIN_BPS`, `SSR_T_TOLERANCE_BPS`, `SSR_T_MARGIN_<MARKET>_BPS` | — | **retired** — ignored whatever they hold; a startup warning names each one still set |
| `UTIL_DEADBAND_BPS` | `50` | |
| `MIN_BAND_ACTION_USDS` | `10000` | whole USDS; smallest steering leg or priority deposit |
| `SLEEVE_FLOOR_BPS` | `1500` | validated < 2000 |
| `DIRECTION_COOLDOWN_HOURS` | `24` | |
| `MONOPOLIST_SHARE_BPS` | `8000` | |
| `SSR_MIN_APY_BPS` | `100` | SSR outside [min, max] → abort the cycle, never default |
| `SSR_MAX_APY_BPS` | `1500` | |
| `MODE_STUSDS` | `RETIRED` | `STEERED` \| `PRIMARY` \| `RETIRED`, enum-validated (`SOUNDING` refuses to start); at most one `PRIMARY` |
| `MODE_CBBTC` | `STEERED` | |
| `MODE_WSTETH` | `STEERED` | |
| `MODE_WETH` | `RETIRED` | |
| `MODE_PTSUSDS` | `STEERED` | `.env.example` sets `PRIMARY` |
| `DRY_RUN` | `false` | `true` = compute + trace, execute nothing (shadow mode) |

Existing allocator envs (`RPC_URL`, `PRIVATE_KEY`, `SAFE_ADDRESS`,
`VAULT_ADDRESS`, `ADAPTER_ADDRESS`, `ORACLE_*`, `LLTV_*`) are unchanged —
see `usds-flagship/README.md`. In bands mode `PT_SUSDS_ABSOLUTE_CAP_USDS`
only serves as the amount-cap fallback for PT-sUSDS (`computeMarketCap`);
`CAP_PTSUSDS_USDS` overrides it.

## Pre-flight safety checks

The reconciled legs are the only authority on what a cycle may move; before a
batch is signed the executor re-verifies, on the pinned snapshot: every call
maps to a leg (same direction, amount not above the leg, the position, or the
step cap; one call per market), the post-batch sleeve does not cross out of
[15%, 20%] — or, when drift already put it outside, moves toward the band —
the adapter's total assets match the sum of the configured positions (an
invisible position aborts), each anchor read is within (0, 1000%] APY (a zero
read is a failed read: the IRM floors the anchor at 0.1% APR on-chain), and
the pinned block is still canonical. Any violation aborts the cycle with no
transaction.

## Decision trace

Every cycle logs one `BAND_TRACE` JSON line: the pinned block, `ssrApy`, a
sha256 of the parsed config, one record per market (`rule`, `regime`,
reasons with the resolved absolute thresholds, `targetAmount`,
`targetRateApy`, `anchorApy`, `bandUtilBps` = the target utilization `u*`),
the reconciled legs (final delta + note when reconciliation changed the
wish), and the **log-only A/B borrower-reaction bracket** — the anchor
projected 24 h ahead at post-trade utilization via `anchor-sim`; it vetoes
nothing. The cadence is hourly (`0 * * * *` in `railway.toml`).

### Rule-ID glossary

| rule | meaning |
|---|---|
| `R-HEAT` | held at a target utilization ≥ 90% (the market is cheap; its anchor drifts up) |
| `R-COOL` | held at a target utilization < 90% (the market is expensive; its anchor drifts down) |
| `R-REST` | current borrow rate within `b* ± 10 bps` → no action |
| `R-HOLD` | a PRIMARY market at/above its fill target (cap or utilization floor) |
| `R-DEADBAND` | util within 50 bps of `u*` → hold (regime `REST` in the trace) |
| `R-MINACTION` | \|delta\| < $10k → hold (STEERED and PRIMARY) |
| `R-COOLDOWN` | direction change within 24 h cooldown → hold (STEERED; PRIMARY grow after a deallocate) |
| `R-SHARE` | vault share < 80% → drain suppressed (neutral; grows allowed) |
| `R-PRIORITY-DEPOSIT` | mode PRIMARY: priority deposit up to `min(effectiveCap, utilization floor)` |
| `R-PRIORITY-WITHDRAWAL` | position above marketCap by ≥ $50k (≥ the 100 USDS dust floor at cap 0): priority withdrawal to the cap, bounded by withdrawable liquidity and `MAX_DEALLOCATE_USDS`; hold (same rule, no priority flag) when the withdrawable slice is under the threshold |
| `R-RETIRED` | mode RETIRED: never touched, even above its cap |

## Rollout

- `ALLOCATION_MODE=bps` is the **decision-identical fallback** — static bps
  allocation decisions, including the startup bps-sum validation. Instant
  rollback is a single env flip.
- **Shadow first**: a second Railway service runs `ALLOCATION_MODE=bands`
  with `DRY_RUN=true` against the live vault; the production service stays
  in `bps` mode. Shadow traces are graded before any cutover.
- The rate target replaces the satAPY ladder with **zero env changes**: every
  new knob has a code default, the retired `SSR_T_*` knobs only warn.
- `BOT_PAUSED=true` is the kill switch (logs `paused`, exits 0).

## Limitations (accepted)

- **Event-history attribution**: any Morpho Blue Supply/Withdraw with
  `onBehalf = adapter` counts as a bot action for the cooldown. A
  third-party `forceDeallocate` pollutes conservatively — at worst a 24 h
  hold, never an extra action.
- **The deadband is coarser than the rest band above 90%**: 50 bps of
  utilization is worth ~50 bps of rate there, so a heating market can sit
  anywhere in roughly `b* ± 50 bps` before the bot moves it. The $10k step
  (~30–80 bps of rate on today's markets) is coarser still.
- **Cooling spends sleeve budget**: a COOL deposit is an ordinary grow in the
  waterfill and competes with the PRIMARY fill for the 20% cap; with a full
  sleeve it waits for HEAT withdrawals or TVL growth to free room.
- **A PRIMARY market with no borrow is never seeded** (fill target 0). Its
  first borrower has to arrive before the fill starts.
- **The reconciliation spot rate** is a linear-in-APY approximation of the
  curve (fee = 0, compounding ignored); the controller's target inversion is
  exact. Good enough for ranking deposits.
- **`anchor-sim` segmentation**: the IRM's `wExp` is a chunked Taylor
  approximation, so projected drift depends on how callers segment the
  utilization path. Projections are indicative, not bit-exact forecasts.
- **RETIRED is never drained**, even above its cap. Draining a retired
  market means setting it to `STEERED` with `CAP_<MARKET>_USDS=0` /
  `CAP_<MARKET>_BPS=0`.
- **The 1 bps sliver is not a breach**: `effectiveCap` sits 1 bps under the
  on-chain relative cap, so a position that accrues past it after a fill is
  not drained — it does not exceed `marketCap` when the on-chain cap binds,
  and it is far below `MIN_PRIORITY_WITHDRAWAL_USDS` when the env cap binds.
- **PRIMARY captures budget only** — it never drains other markets to fund
  itself. With a full sleeve its fill comes only from same-batch withdrawals
  (steering drains, priority withdrawals) and TVL growth, one step cap per
  cycle.
