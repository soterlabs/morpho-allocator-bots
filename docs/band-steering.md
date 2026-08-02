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

## Band selection (per STEERED market)

`satAPY = 0.9 × anchorApy` (the supply rate at the IRM's 90% target; fee = 0,
documented approximation). `SSR_t = SSR + SSR_T_MARGIN_BPS`, satisfaction zone
`SSR_t ± SSR_T_TOLERANCE_BPS`. Every threshold derives from SSR_t, so a
governance SSR change moves the whole ladder automatically. At SSR 3.52%
(margin/tolerance 25 bps): SSR_t = 3.77%, zone [3.52%, 4.02%].

| satAPY | band (util held) | rule |
|---|---|---|
| above the zone | **9000** (90%) | `R-BAND90` |
| inside the zone | — no action | `R-HOLD` |
| `[2/3 × SSR_t, zone)` | **9200** (92%) | `R-BAND92` |
| `[1/3 × SSR_t, 2/3 × SSR_t)` | **9300** (93%) | `R-BAND93` |
| `[1/12 × SSR_t, 1/3 × SSR_t)` | **9400** (94%) | `R-BAND94` |
| below `1/12 × SSR_t` | **9500** (95%) | `R-BAND95` |

## Gates (in order, per market)

Each gate converts the computed delta into a hold carrying its rule:

1. **util deadband**: `|utilBps − bandUtilBps| ≤ 50 bps` → `R-DEADBAND`
2. **min action**: `|delta| < $100k` (`MIN_BAND_ACTION_USDS`) → `R-MINACTION`
3. **direction cooldown**: grow within 24 h of a deallocate, or drain within
   24 h of an allocate (from on-chain Supply/Withdraw events,
   `onBehalf = adapter`); same-direction moves are not limited → `R-COOLDOWN`
4. **monopolist share**: drain while vault share of market supply < 80% →
   `R-SHARE` (we are not the dominant supplier; draining cannot move util —
   go neutral; grows still allowed)

A surviving delta is clamped to the per-cycle step caps `MAX_ALLOCATE_USDS` /
`MAX_DEALLOCATE_USDS`; a larger move spreads over subsequent cycles.

## Vault-level reconciliation (`reconcile.ts`)

The per-market wishes are reconciled against the sleeve limits before the
batch is built. The allocated sleeve must end the batch inside **[15%, 20%]**
of totalAssets; both limits are hard and are checked on the post-batch state:

- **deposits exceed the 20% cap** → waterfilling: the deposit budget (cap
  headroom + same-batch withdrawals) fills the highest-earning markets first,
  down to a common spot supply APY — no dollar of the budget could be moved
  to a better market.
- **withdrawals break the 15% floor** → cut in band tiers from the deepest
  band down: whole tiers are served fully; the tier the budget (floor
  headroom + same-batch deposits) cannot cover lands on one common
  utilization `u* = pooledBorrow / (pooledSupply − budget)`, so every market
  in it heats at the same tempo; shallower tiers wait for the next cycle.

Legs below `MIN_BAND_ACTION_USDS` are then dropped; an empty batch does not
fly.

## Market modes

| mode | behavior |
|---|---|
| `STEERED` | the band ladder above |
| `RETIRED` | the bot never touches the market |
| `SOUNDING` | recognized name; configuring it refuses to start |

| market (index) | mode env | default |
|---|---|---|
| stUSDS/USDS (0) | `MODE_STUSDS` | `RETIRED` |
| cbBTC/USDS (1) | `MODE_CBBTC` | `STEERED` |
| wstETH/USDS (2) | `MODE_WSTETH` | `STEERED` |
| PT-sUSDS/USDS (3) | `MODE_PTSUSDS` | `STEERED` |
| WETH/USDS (4) | `MODE_WETH` | `STEERED` |

## Environment variables (bands mode)

| variable | default | notes |
|---|---|---|
| `ALLOCATION_MODE` | **REQUIRED** | `bps` \| `bands`, no default. `bps` = static-target allocation decisions unchanged (incl. `validateTargetBpsSum`); fail-loud execution hardening is shared by both modes |
| `BOT_PAUSED` | `false` | `true` → log `paused`, exit 0 |
| `MAX_ALLOCATE_USDS` | **REQUIRED** (> 0) | per-market per-cycle grow step cap, whole USDS |
| `MAX_DEALLOCATE_USDS` | **REQUIRED** (> 0) | per-market per-cycle drain step cap (in `bps` mode stays optional, `0` = no cap) |
| `SSR_T_MARGIN_BPS` | `25` | global SSR_t margin for STEERED markets |
| `SSR_T_MARGIN_<MARKET>_BPS` | unset | per-market override of the margin (`CBBTC`/`WSTETH`/`WETH`/`PTSUSDS`/`STUSDS`); unset = global |
| `SSR_T_TOLERANCE_BPS` | `25` | zone half-width; validated ≤ margin |
| `UTIL_DEADBAND_BPS` | `50` | |
| `MIN_BAND_ACTION_USDS` | `100000` | whole USDS |
| `SLEEVE_FLOOR_BPS` | `1500` | validated < 2000 |
| `DIRECTION_COOLDOWN_HOURS` | `24` | |
| `MONOPOLIST_SHARE_BPS` | `8000` | |
| `SSR_MIN_APY_BPS` | `100` | SSR outside [min, max] → abort the cycle, never default |
| `SSR_MAX_APY_BPS` | `1500` | |
| `MODE_STUSDS` | `RETIRED` | enum-validated |
| `MODE_CBBTC` | `STEERED` | |
| `MODE_WSTETH` | `STEERED` | |
| `MODE_WETH` | `STEERED` | |
| `MODE_PTSUSDS` | `STEERED` | |
| `DRY_RUN` | `false` | `true` = compute + trace, execute nothing (shadow mode) |

Existing allocator envs (`RPC_URL`, `PRIVATE_KEY`, `SAFE_ADDRESS`,
`VAULT_ADDRESS`, `ADAPTER_ADDRESS`, `ORACLE_*`, `LLTV_*`,
`PT_SUSDS_ABSOLUTE_CAP_USDS`) are unchanged — see `usds-flagship/README.md`.

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
| `R-HOLD` | satAPY inside the zone → no action |
| `R-DEADBAND` | util within 50 bps of band → hold |
| `R-MINACTION` | \|delta\| < $100k → hold |
| `R-COOLDOWN` | direction change within 24 h cooldown → hold |
| `R-SHARE` | vault share < 80% → drain suppressed (neutral; grows allowed) |
| `R-RETIRED` | mode RETIRED: never touched |

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
