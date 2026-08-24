# Band steering (`ALLOCATION_MODE=bands`)

Rate-steering allocator for the Flagship USDS vault (`usds-flagship/`).
Authoritative env parsing: `usds-flagship/src/band-config.ts`
(`parseBandConfig` — throws at startup on any missing/invalid value).

## What it does

Instead of holding each market at a static bps target, the bot holds each
market at a **utilization band** — 90 / 92 / 93 / 94 / 95% — chosen from the
market's satAPY against thresholds derived from the Sky Savings Rate. SSR is
read on-chain from `sUSDS.ssr()`
(`0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`; per-second rate in RAY,
`APY = (ssr / 1e27) ^ 31536000 − 1`). Because Morpho's Adaptive Curve IRM
drifts its anchor (`rateAtTarget`) up whenever utilization is held above 90%,
holding a cheap market at 92–95% steadily raises what borrowers pay, while a
market that already pays its keep is topped up from idle at the 90% neutral
point. The target amount for a market is the vault position that puts the
market at its band: `targetSupplyTotal = ceil(borrow × 10000 / bandUtilBps)`.
The band also becomes that market's dynamic `maxUtilizationBps`, so the
existing withdrawal clamps land drains exactly on band.

Two things sit outside the band ladder, both **priority** wishes that
reconciliation serves before the ordinary ones. At most one market is
**PRIMARY** (PT-sUSDS today): it has no band and is always asked to fill up to
its cap — a **priority deposit**, served before every other deposit. And every
non-RETIRED market carries an env **cap** (`CAP_<MARKET>_USDS` /
`CAP_<MARKET>_BPS`); a position above it becomes a **priority withdrawal**
back to the cap that bypasses every steering gate. Each market emits at most
one wish per cycle, chosen in this order: priority withdrawal (cap breach) →
priority deposit (PRIMARY fill) → band steering.

## Band selection (per STEERED market)

`satAPY = 0.9 × anchorApy` (the supply rate at the IRM's 90% target; fee = 0,
documented approximation). `SSR_t = SSR + SSR_T_MARGIN_BPS`, satisfaction zone
`SSR_t ± SSR_T_TOLERANCE_BPS`. Every threshold derives from SSR_t, so a
governance SSR change moves the whole ladder automatically. At SSR 3.52%
(margin 0, tolerance 25 bps): SSR_t = 3.52%, zone [3.27%, 3.77%] — symmetric
around SSR, a rate slightly under SSR is accepted for more competitive borrow
rates.

| satAPY | band (util held) | rule |
|---|---|---|
| above the zone | **9000** (90%) | `R-BAND90` |
| inside the zone | — no action | `R-HOLD` |
| `[2/3 × SSR_t, zone)` | **9200** (92%) | `R-BAND92` |
| `[1/3 × SSR_t, 2/3 × SSR_t)` | **9300** (93%) | `R-BAND93` |
| `[1/12 × SSR_t, 1/3 × SSR_t)` | **9400** (94%) | `R-BAND94` |
| below `1/12 × SSR_t` | **9500** (95%) | `R-BAND95` |

## Gates

Every deposit/withdrawal wish — a band target or the PRIMARY fill — is sized
by the same steps (`sizeWish` in `band-controller.ts`), whatever chose its
target:

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
Steering adds two gates of its own around the shared ones, so the order per
STEERED market is:

1. **util deadband**: `|utilBps − bandUtilBps| ≤ 50 bps` → `R-DEADBAND`
2. min action, direction cooldown (shared)
3. **monopolist share**: drain while vault share of market supply < 80% →
   `R-SHARE` (we are not the dominant supplier; draining cannot move util —
   go neutral; grows still allowed)
4. step caps (shared)

A priority withdrawal skips all of this — see below.

## Market caps

Same semantics as `bps` mode: caps live off-chain in env (the bot never
reads the on-chain absolute cap), and the on-chain relative cap is read only
to clamp allocations at execution. A market may carry an optional amount cap
(`CAP_<MARKET>_USDS`, whole USDS — PT-sUSDS falls back to
`PT_SUSDS_ABSOLUTE_CAP_USDS`, its bps-mode cap) and/or an optional share cap
(`CAP_<MARKET>_BPS`, bps of totalAssets). On the cycle's pinned snapshot:

- `marketCap` = the smaller of the caps set — the breach line; undefined for
  a market with no env cap, which then never emits a priority withdrawal.
- `effectiveCap = min(on-chain relative cap − 1 bps headroom, marketCap)` —
  the deposit ceiling; band targets and the PRIMARY fill clamp to it (just
  the on-chain bound when there is no env cap).

The on-chain relative cap only clamps deposits; it never triggers a drain.

## Priority withdrawal (cap breach)

Evaluated before any steering, for STEERED and PRIMARY markets. A position
above `marketCap` by at least `MIN_PRIORITY_WITHDRAWAL_USDS` ($50k) — or by
at least the 100 USDS dust floor when `marketCap` is 0, which drains the
market down to that floor — becomes a **priority withdrawal** back to the cap
(`R-PRIORITY-WITHDRAWAL`). A slice the pool's liquidity leaves under that
threshold is held rather than traded (same rule, no priority flag). A breach
is a policy violation, not a rate signal, so it skips every steering gate: no
band, no deadband, no direction cooldown, no monopolist share. Only two
things bound it: the pool's withdrawable liquidity (`supply − borrow − 5%
reserve`, the executor's own `LIQUIDITY_RESERVE_PERCENT` rule, so the plan
never promises liquidity the executor would refuse) and `MAX_DEALLOCATE_USDS`.
With no withdrawable liquidity the market holds and retries next cycle. The
withdrawal replaces the market's steering wish — one wish per market per
cycle.

RETIRED markets stay untouched even above their cap (`R-RETIRED`).

## Priority deposit (PRIMARY market)

At most one market (PT-sUSDS today, `MODE_PTSUSDS=PRIMARY`). No band and no
rate input — satAPY plays no role. Its wish is always the whole gap up to
`effectiveCap` as a **priority deposit** (`R-PRIORITY-DEPOSIT`), which
reconciliation serves before any other deposit. The shared sizing still
applies: a gap below `MIN_BAND_ACTION_USDS` ($10k) holds (`R-MINACTION`), a
grow within 24 h of a deallocate holds (`R-COOLDOWN`), and the grow is
clamped to `MAX_ALLOCATE_USDS`. At or above the cap the market holds
(`R-HOLD`); it withdraws only through the priority-withdrawal rule.

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
- **withdrawals break the 15% floor** → priority withdrawals (cap breaches)
  are served first — the PRIMARY market's ahead of the others, then the
  largest first — each up to what is left of the budget (floor headroom +
  same-batch deposits); the band wishes then share the remainder in tiers
  from the deepest band down: whole tiers are served fully; the tier the
  budget cannot cover lands on one common utilization
  `u* = pooledBorrow / (pooledSupply − budget)`, so every market in it heats
  at the same tempo; shallower tiers wait for the next cycle.

Legs below their drop threshold are then removed: `MIN_BAND_ACTION_USDS`
($10k) for a steering leg or a priority deposit,
`MIN_PRIORITY_WITHDRAWAL_USDS` ($50k) for a priority withdrawal — except that
a zero-cap withdrawal smaller than $50k passes as a whole (the controller
already sized it above the 100 USDS dust floor, and it bypasses the
executor's dust floor so the market ends holding nothing) while a floor cut
leaving only part of it is dropped. An empty batch does not fly.

## Market modes

| mode | behavior |
|---|---|
| `STEERED` | the band ladder above; priority withdrawal above its cap |
| `PRIMARY` | no band: always asks to fill up to its cap as a priority deposit, served before every other deposit; priority withdrawal above its cap. At most one market (startup throw otherwise); `bps` mode rejects it |
| `RETIRED` | the bot never touches the market — not even above its cap; caps optional |
| `SOUNDING` | recognized name; configuring it refuses to start |

| market (index) | mode env | code default (env unset) | `.env.example` |
|---|---|---|---|
| stUSDS/USDS (0) | `MODE_STUSDS` | `RETIRED` | `RETIRED` |
| cbBTC/USDS (1) | `MODE_CBBTC` | `STEERED` | `STEERED` |
| wstETH/USDS (2) | `MODE_WSTETH` | `STEERED` | `STEERED` |
| PT-sUSDS/USDS (3) | `MODE_PTSUSDS` | `STEERED` | `PRIMARY` |
| WETH/USDS (4) | `MODE_WETH` | `STEERED` | `STEERED` |

## Environment variables (bands mode)

| variable | default | notes |
|---|---|---|
| `ALLOCATION_MODE` | **REQUIRED** | `bps` \| `bands`, no default. `bps` = static-target allocation decisions unchanged (incl. `validateTargetBpsSum`); fail-loud execution hardening is shared by both modes |
| `BOT_PAUSED` | `false` | `true` → log `paused`, exit 0 |
| `MAX_ALLOCATE_USDS` | **REQUIRED** (≥ `MIN_BAND_ACTION_USDS`) | per-market per-cycle grow step cap, whole USDS |
| `MAX_DEALLOCATE_USDS` | **REQUIRED** (≥ `MIN_BAND_ACTION_USDS` and ≥ `MIN_PRIORITY_WITHDRAWAL_USDS`) | per-market per-cycle drain step cap (in `bps` mode stays optional, `0` = no cap) |
| `CAP_<MARKET>_USDS` | unset (PT-sUSDS: `PT_SUSDS_ABSOLUTE_CAP_USDS`) | optional cap amount, whole USDS (`CBBTC`/`WSTETH`/`WETH`/`PTSUSDS`/`STUSDS`); `0` = hold nothing, drain everything |
| `CAP_<MARKET>_BPS` | unset | optional cap as bps of totalAssets; `marketCap` = the smaller of the caps set; a market with none is bounded by the on-chain relative cap only (as in `bps` mode) and never emits a priority withdrawal |
| `MIN_PRIORITY_WITHDRAWAL_USDS` | `50000` | smallest priority withdrawal, whole USDS; a smaller breach waits (a zero cap drains from the 100 USDS dust floor instead) |
| `SSR_T_MARGIN_BPS` | `0` | global SSR_t margin for STEERED markets |
| `SSR_T_MARGIN_<MARKET>_BPS` | unset | per-market override of the margin (`CBBTC`/`WSTETH`/`WETH`/`PTSUSDS`/`STUSDS`); unset = global |
| `SSR_T_TOLERANCE_BPS` | `25` | zone half-width; validated ≤ margin |
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
| `MODE_WETH` | `STEERED` | |
| `MODE_PTSUSDS` | `STEERED` | `.env.example` sets `PRIMARY` |
| `DRY_RUN` | `false` | `true` = compute + trace, execute nothing (shadow mode) |

Existing allocator envs (`RPC_URL`, `PRIVATE_KEY`, `SAFE_ADDRESS`,
`VAULT_ADDRESS`, `ADAPTER_ADDRESS`, `ORACLE_*`, `LLTV_*`) are unchanged —
see `usds-flagship/README.md`. `PT_SUSDS_ABSOLUTE_CAP_USDS` is `bps`-mode /
optimizer only; in bands mode PT-sUSDS is bounded by `CAP_PTSUSDS_*`.

## Pre-flight safety checks

The reconciled legs are the only authority on what a cycle may move; before a
batch is signed the executor re-verifies, on the pinned snapshot: every call
maps to a leg (same direction, amount not above the leg, the position, or the
step cap; one call per market), the post-batch sleeve does not cross out of
[15%, 20%] — or, when drift already put it outside, moves toward the band —
the adapter's total assets match the sum of the configured positions (an
invisible position aborts), each anchor read is within [0, 1000%] APY, and
the pinned block is still canonical. Any violation aborts the cycle with no
transaction.

## Decision trace

Every cycle logs one `BAND_TRACE` JSON line: the pinned block, `ssrApy`, a
sha256 of the parsed config, one record per market (rule + reasons with the
resolved absolute thresholds + `targetAmount` + `bandUtilBps`), the
reconciled legs (final delta + note when reconciliation changed the wish),
and the **log-only A/B borrower-reaction bracket** — the anchor projected
24 h ahead at post-trade utilization via `anchor-sim`; it vetoes nothing.

### Rule-ID glossary

| rule | meaning |
|---|---|
| `R-BAND90` … `R-BAND95` | held at that utilization band |
| `R-HOLD` | satAPY inside the zone → no action; also a PRIMARY market at/above its cap |
| `R-DEADBAND` | util within 50 bps of band → hold |
| `R-MINACTION` | \|delta\| < $10k → hold (STEERED and PRIMARY) |
| `R-COOLDOWN` | direction change within 24 h cooldown → hold (STEERED; PRIMARY grow after a deallocate) |
| `R-SHARE` | vault share < 80% → drain suppressed (neutral; grows allowed) |
| `R-PRIORITY-DEPOSIT` | mode PRIMARY: priority deposit up to effectiveCap |
| `R-PRIORITY-WITHDRAWAL` | position above marketCap by ≥ $50k (≥ the 100 USDS dust floor at cap 0): priority withdrawal to the cap, bounded by withdrawable liquidity and `MAX_DEALLOCATE_USDS`; hold (same rule, no priority flag) when the withdrawable slice is under the threshold |
| `R-RETIRED` | mode RETIRED: never touched, even above its cap |

## Rollout

- `ALLOCATION_MODE=bps` is the **decision-identical fallback** — static bps
  allocation decisions, including the startup bps-sum validation. Instant
  rollback is a single env flip.
- **Shadow first**: a second Railway service runs `ALLOCATION_MODE=bands`
  with `DRY_RUN=true` against the live vault; the production service stays
  in `bps` mode. Shadow traces are graded before any cutover.
- `BOT_PAUSED=true` is the kill switch (logs `paused`, exits 0).

## Limitations (accepted)

- **Event-history attribution**: any Morpho Blue Supply/Withdraw with
  `onBehalf = adapter` counts as a bot action for the cooldown. A
  third-party `forceDeallocate` pollutes conservatively — at worst a 24 h
  hold, never an extra action.
- **`satAPY = 0.9 × anchorApy` is an approximation** (fee = 0, utilization
  exactly at the 90% target, compounding ignored); the reconciliation spot
  rate uses the same linear-in-APY approximation. Good enough for band
  selection and deposit ranking.
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
  (band drains, priority withdrawals) and TVL growth, one step cap per cycle.
