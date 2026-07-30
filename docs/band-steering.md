# Band steering (`ALLOCATION_MODE=bands`)

Phase A of the rate-steering allocator for the Flagship USDS vault
(`usds-flagship/`). All parameters below were decided 2026-07-30 (see
`docs/plans/2026-07-30-rate-steering-implementation-plan.md`, section 8).
Authoritative env parsing: `usds-flagship/src/band-config.ts`
(`parseBandConfig` — throws at startup on any missing/invalid value).

## What it does

Instead of holding each market at a static bps target, the bot holds each
market at a **utilization band** — 90 / 92 / 93 / 94% — chosen by where the
market's rate sits relative to thresholds derived from the Sky Savings Rate.
SSR is read on-chain from `sUSDS.ssr()`
(`0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`; per-second rate in RAY,
`APY = (ssr / 1e27) ^ 31536000 − 1`). Because Morpho's Adaptive Curve IRM
drifts its anchor (`rateAtTarget`) up whenever utilization is held above 90%,
holding a cheap market at 93–94% steadily raises what borrowers pay, while a
market that already pays its keep is parked at the 90% neutral point. The
target amount for a market is the vault position that puts the market at its
band: `targetSupplyTotal = ceil(borrow × 10000 / bandUtilBps)`. The band also
becomes that market's dynamic `maxUtilizationBps`, so the existing withdrawal
clamps land drains exactly on band.

## Band selection (STEERED markets)

`SSR_t = SSR + 15 bps` (the rate the sleeve must beat);
`supply@target = 0.9 × anchorApy` (fee = 0, documented approximation).
Precedence top to bottom:

| condition | band (util held) | rule |
|---|---|---|
| `supply@target ≥ SSR_t` | **9000** (90%) — harvest / neutral | `R-HARV` |
| `supplyApy < 4/7 × SSR` (LOW) | **9400** (94%) — drain hard | `R-DRAIN94` |
| `supplyApy > 8/7 × SSR` (HIGH) | **9200** (92%) — gentle pressure | `R-HIGH92` |
| otherwise | **9300** (93%) — mid band | `R-MID93` |

LOW/HIGH are **proportional to SSR** (integer fractions, deterministic): at
SSR = 3.5% they resolve to LOW = 2.0%, HIGH = 4.0%. Resolved absolute
thresholds are logged in every decision trace.

## Decided parameters

| parameter | value |
|---|---|
| SSR_t margin | SSR + 15 bps (`SSR_T_MARGIN_BPS`, one global margin — no per-market overrides in v1, see Limitations) |
| LOW / HIGH thresholds | 4/7 × SSR / 8/7 × SSR |
| bands (util the bot holds) | harvest 9000 · high 9200 · mid 9300 · drain 9400 bps |
| util deadband | 50 bps |
| min steering action | $30k (`MIN_BAND_ACTION_USDS`, 18-dec) |
| hard sleeve floor | 12% of totalAssets (`SLEEVE_FLOOR_BPS=1200`) |
| direction-change cooldown | 24 h (per market, reconstructed from on-chain events) |
| monopolist neutral threshold | 80% vault share of market supply |
| SOUNDING tranches | $3M first / $1.5M follow-ups; stick-gate util ≥ 9500 bps; feed cooldown 24 h |
| SSR sanity bounds | [100, 1500] bps APY — abort the cycle outside |
| per-cycle step caps | `MAX_ALLOCATE_USDS` / `MAX_DEALLOCATE_USDS`, REQUIRED (> 0) in bands mode |
| cadence | Railway cron `*/20 * * * *` (all timestamps UTC) |

## Market modes

Set per market via env, validated against the enum. `RETIRED` → target 0 and
sweep. Wind-down is **computed from maturity**, not configured.

| market (index) | mode env | default | notes |
|---|---|---|---|
| stUSDS/USDS (0) | `MODE_STUSDS` | `RETIRED` | risk-quarantined, never allocate |
| cbBTC/USDS (1) | `MODE_CBBTC` | `STEERED` | |
| wstETH/USDS (2) | `MODE_WSTETH` | `STEERED` | |
| PT-sUSDS/USDS (3) | `MODE_PTSUSDS` | `SOUNDING` | maturity 1795651200 = 2026-11-26T00:00:00Z |
| WETH/USDS (4) | `MODE_WETH` | `STEERED` | full band participant again |

**Wind-down overlay** (any market with `maturityUtcSec` set — today PT-sUSDS):

| from (UTC) | behavior | rule |
|---|---|---|
| T−30d — 2026-10-27 | grows blocked (a would-be grow becomes hold) | `R-WD30` |
| T−14d — 2026-11-12 | drains like RETIRED (target 0, sweep) | `R-WD14` |

## SOUNDING mode (top-down demand discovery)

Kacper's "wrzucamy 3M i patrzymy czy chwyci": instead of steering the rate,
we probe how deep borrower demand runs by feeding supply in tranches and
watching whether it gets borrowed.

- **Feed rule**: allocate a tranche iff util ≥ 95% (the previous tranche
  *stuck* — borrowers absorbed it) AND ≥ 24 h since the last feed. First
  tranche tops the position up to $3M; follow-ups are $1.5M. Grows are
  clamped by `MAX_ALLOCATE_USDS` and the effective cap (on-chain cap with
  headroom, min'd with the $5M PT absolute cap). Rule `R-SND-FEED`;
  otherwise hold, `R-SND-HOLD` — including when the clamps reduce a
  would-be feed to zero movement (the rule reports the realized action).
- **A tranche that doesn't stick halts feeding automatically** (the util
  gate fails). SOUNDING **never drains** — draining defeats discovery;
  exposure is bounded by the effective cap. The wind-down overlay still
  applies.
- **Graduation**: when `supply@target ≥ SSR` the market has proven it pays
  its keep — flip its mode env to `STEERED` (config change; v1 does not
  auto-graduate).

## Action gates (STEERED, applied in order)

Each gate converts the computed delta into a hold with its rule:

1. `|utilBps − bandUtilBps| ≤ 50 bps` → `R-DEADBAND`
2. `|delta| < $30k` → `R-MINACTION`
3. grow within 24 h of a deallocate, or drain within 24 h of an allocate
   (from on-chain Supply/Withdraw events, `onBehalf = adapter`) → `R-COOLDOWN`
4. drain while vault share of market supply < 80% → `R-SHARE` (we are not
   the dominant supplier; draining cannot move util — go neutral; grows
   still allowed)

Surviving deltas are clamped to the per-cycle step caps. Finally a **sleeve
floor** pass runs over the whole vector: if the summed targets fall below
12% of totalAssets, STEERED drains are restored (largest first) until the
floor is met — RETIRED/wind-down sweeps are never restored; adjusted
decisions get `R-FLOOR` appended to their reasons.

## Environment variables (bands mode)

| variable | default | notes |
|---|---|---|
| `ALLOCATION_MODE` | **REQUIRED** | `bps` \| `bands`, no default. `bps` = today's allocation decisions unchanged (incl. `validateTargetBpsSum`); fail-loud execution hardening is shared by both modes |
| `BOT_PAUSED` | `false` | `true` → log `paused`, exit 0 |
| `MAX_ALLOCATE_USDS` | **REQUIRED** (> 0) | per-market per-cycle grow step cap, whole USDS |
| `MAX_DEALLOCATE_USDS` | **REQUIRED** (> 0) | per-market per-cycle drain step cap (in `bps` mode stays optional, `0` = no cap) |
| `SSR_T_MARGIN_BPS` | `15` | one global margin applied to every STEERED market — per-market override envs are NOT implemented in v1 (a `SSR_T_MARGIN_BPS_<MARKET>` var would be silently ignored; see Limitations) |
| `BAND_UTIL_HARVEST_BPS` | `9000` | monotonicity validated: drain ≥ mid ≥ high ≥ harvest |
| `BAND_UTIL_HIGH_BPS` | `9200` | |
| `BAND_UTIL_MID_BPS` | `9300` | |
| `BAND_UTIL_DRAIN_BPS` | `9400` | |
| `UTIL_DEADBAND_BPS` | `50` | |
| `MIN_BAND_ACTION_USDS` | `30000` | whole USDS |
| `SLEEVE_FLOOR_BPS` | `1200` | validated < 2000 |
| `SOUNDING_FIRST_TRANCHE_USDS` | `3000000` | |
| `SOUNDING_NEXT_TRANCHE_USDS` | `1500000` | |
| `SOUNDING_STICK_UTIL_BPS` | `9500` | |
| `SOUNDING_FEED_COOLDOWN_HOURS` | `24` | |
| `DIRECTION_COOLDOWN_HOURS` | `24` | |
| `MONOPOLIST_SHARE_BPS` | `8000` | |
| `SSR_MIN_APY_BPS` | `100` | SSR outside [min, max] → abort the cycle, never default |
| `SSR_MAX_APY_BPS` | `1500` | |
| `MODE_STUSDS` | `RETIRED` | enum-validated: `STEERED` \| `SOUNDING` \| `RETIRED` |
| `MODE_CBBTC` | `STEERED` | |
| `MODE_WSTETH` | `STEERED` | |
| `MODE_WETH` | `STEERED` | |
| `MODE_PTSUSDS` | `SOUNDING` | |
| `DRY_RUN` | `false` | `true` = compute + trace, execute nothing (shadow mode) |

Existing allocator envs (`RPC_URL`, `PRIVATE_KEY`, `SAFE_ADDRESS`,
`VAULT_ADDRESS`, `ADAPTER_ADDRESS`, `ORACLE_*`, `LLTV_*`,
`PT_SUSDS_ABSOLUTE_CAP_USDS`) are unchanged — see `usds-flagship/README.md`.

## Decision trace

Every cycle logs one JSON trace: the block-pinned inputs (`ssrApy`, the
resolved absolute LOW/HIGH/SSR_t thresholds, `totalAssets`, timestamp UTC)
plus one record per market matching the `BandDecision` shape:

```json
{
  "index": 2,
  "targetAmount": "2400000000000000000000000",
  "bandUtilBps": 9300,
  "sweep": false,
  "rule": "R-MID93",
  "reasons": [
    "supplyApy 2.61% in [LOW 2.00%, HIGH 4.00%] (SSR 3.50%, SSR_t 3.65%)",
    "util 9612 bps -> band 9300, delta -1.2M"
  ]
}
```

`targetAmount` is the absolute vault position targeted this cycle;
`bandUtilBps` feeds the withdrawal clamp (`undefined` for SOUNDING grows);
`sweep` marks drain-to-zero semantics. The trace also carries the **log-only
A/B borrower-reaction bracket**: the anchor projected 24 h ahead at
post-trade utilization via `anchor-sim` — recorded for shadow analysis, it
vetoes nothing in v1.

### Rule-ID glossary

| rule | meaning |
|---|---|
| `R-HARV` | supply@target ≥ SSR_t → hold 90% harvest band |
| `R-DRAIN94` | supplyApy < 4/7 × SSR → hold 94% drain band |
| `R-HIGH92` | supplyApy > 8/7 × SSR → hold 92% band |
| `R-MID93` | between thresholds → hold 93% band |
| `R-SND-FEED` | SOUNDING: tranche fed (stick-gate + cooldown passed) |
| `R-SND-HOLD` | SOUNDING: hold (tranche not stuck, within feed cooldown, or the cap clamps left the position unchanged) |
| `R-RETIRED` | mode RETIRED: target 0, sweep, drain-band liquidity cap |
| `R-WD30` | within 30 d of maturity: grow blocked → hold |
| `R-WD14` | within 14 d of maturity: drains like RETIRED |
| `R-COOLDOWN` | direction change within 24 h cooldown → hold |
| `R-DEADBAND` | util within 50 bps of band → hold |
| `R-MINACTION` | \|delta\| < $30k → hold |
| `R-SHARE` | vault share < 80% → drain suppressed (neutral; grows allowed) |
| `R-FLOOR` | appended reason: drain restored by the 12% sleeve-floor pass |

## Rollout

- `ALLOCATION_MODE=bps` is the **decision-identical fallback** — today's
  static bps allocation decisions, including the startup bps-sum validation.
  Instant rollback is a single env flip. (Failure-path behavior is hardened
  in BOTH modes versus the pre-bands code: `RPC_URL` required, non-zero exit
  on revert/timeout instead of a swallowed error, pending-nonce guard,
  bounded receipt wait, 20-minute cadence — per the repo's fail-loud rules.)
- **Shadow first**: a second Railway service runs `ALLOCATION_MODE=bands`
  with `DRY_RUN=true` against the live vault; the production service stays
  in `bps` mode. Shadow traces are graded before any cutover.
- The A/B borrower-reaction bracket is **log-only in v1**: the 24 h anchor
  projection appears in every trace but never vetoes or shrinks an action.
- `BOT_PAUSED=true` is the kill switch (logs `paused`, exits 0).

## Limitations (v1, accepted)

- **Event-history attribution**: any Morpho Blue Supply/Withdraw with
  `onBehalf = adapter` counts as a bot action for the cooldowns. A
  third-party `forceDeallocate` pollutes conservatively — at worst a 24 h
  hold, never an extra action.
- **No veto bracket**: the borrower-reaction projection is trace-only; a
  large drain into an inelastic market is bounded only by
  `MAX_DEALLOCATE_USDS` and the band clamp.
- **`supply@target = 0.9 × anchorApy` is an approximation** (assumes fee = 0
  and utilization exactly at the 90% target; compounding ignored). Good
  enough for band selection; both harvest-condition forms are logged so
  shadow data can refine it.
- **`anchor-sim` segmentation**: the IRM's `wExp` is a chunked Taylor
  approximation, so projected drift depends on how callers segment the
  utilization path; the simulator never merges or splits the segments it is
  given. Projections are indicative, not bit-exact forecasts.
- **SOUNDING never drains** on its own — exposure in a sounding market is
  bounded only by its effective cap and the wind-down/RETIRED overlays.
- **Single global SSR_t margin**: the decided-parameters note "per-market
  override envs exist" is NOT implemented in v1 — a recorded deviation. The
  pinned `BandConfig`/`MarketObservation` interfaces carry exactly one
  global `SSR_T_MARGIN_BPS`, and `decideSteered` applies it to every
  STEERED market. Setting e.g. `SSR_T_MARGIN_BPS_CBBTC` has no effect.
  Per-market margins need a coordinated interface change (per-market field
  threaded through `MarketObservation`) in a later phase.
