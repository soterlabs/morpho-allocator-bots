# Rate-target steering — design brief (2026-10-05)

Status: agreed in principle (Kacper + Jan, #data-small-polish thread
2026-10-05, https://ekliptyka.slack.com/archives/C0BM8GABT6Y/p1790930393549559).
Scope: `usds-flagship/`, bands mode. Ships with **zero Railway env changes**.

## Goal

Hold each steered market's **current borrow rate at SSR + 60 bps** (band
SSR + 50–70 bps). That is the number borrowers react to. Today's ladder
holds a *utilization rung* chosen from satAPY, which overshoots: on
2026-10-05 cbBTC sat at 92% util / 5.3% borrow and wstETH at 92% / 6.1%
(anchor 3.26% / 3.75%, SSR 3.6%), and borrowers left above ~5%.

## Mechanics we rely on (Morpho Adaptive Curve IRM)

- `borrow = anchor × curve(err)`, `err = (u − 0.9) / 0.1` above 90%,
  `(u − 0.9) / 0.9` below. `curve = 1 + 3·err` above, `1 + 0.75·err` below.
- `anchor` (`rateAtTarget`) drifts: `d ln(anchor)/dt = 50/yr × err`.
  Above 90% it rises (×2 in ~25 d at 92%, ~50 d at 91%); below it falls
  9× slower per pp. **90% is the only utilization where the rate stands
  still.** Anything above 90% is temporary heating.
- Fee = 0 on our markets, so `supply ≈ borrow × u`. At rest (90%)
  suppliers get 0.9 × target: SSR + 9 bps (margin 50) to SSR + 27 bps
  (margin 70) at SSR 3.6%. Holding above 90% would add only ~4 bps of
  supply APY per pp and cannot be held — not a goal.

## Design — one cycle per market (hourly cron, `0 * * * *`)

1. **Inputs** (all read today): SSR (`sUSDS.ssr()`), `anchorApy`
   (`rateAtTarget`), market borrow/supply, vault position, caps.
2. **Target rate** `b* = SSR + RATE_MARGIN_BPS` (default 60; optional
   per-market override).
3. **Target utilization** `u* = curve⁻¹(b*, anchor)`:
   - `b* ≥ anchor`: `u* = 0.9 + 0.1 × (b*/anchor − 1) / 3`
   - `b* < anchor`: `u* = 0.9 + 0.9 × (b*/anchor − 1) / 0.75`
   - clamp to `[UTIL_MIN_BPS, UTIL_MAX_BPS]` (defaults 8000, 9500).
   Closed form is exact for the piecewise-linear curve; unit-test it by
   round-tripping through `AdaptiveCurveIrmLib.getBorrowRate` (already a
   dependency, see `anchor-sim.ts`) at zero elapsed time.
4. **Target position** `targetSupplyTotal = ceil(borrow / u*)`,
   `delta = target − vaultAssets`. Same math as today with a continuous
   `bandUtilBps = round(u* × 10000)`; it still doubles as the market's
   dynamic `maxUtilizationBps` for the withdrawal clamps.
5. **Regime** (trace label only; the action is the sign of `delta`):
   `R-HEAT` (`u* > 90%`), `R-REST` (current rate inside SSR + 50–70 bps, i.e. ±10 bps around `b*`, or deadband hit), `R-COOL` (`u* < 90%`).
   Replaces `R-BAND90…95`. `R-HOLD` stays for PRIMARY at cap.
6. **Gates — unchanged, same order:** util deadband (`UTIL_DEADBAND_BPS`
   50) → min action (`MIN_BAND_ACTION_USDS` 10 000) → direction cooldown
   24 h → monopolist share 80% → step caps.
7. **Reconcile / pre-flight — unchanged.** Floor-cut tiers key on
   `bandUtilBps`; with continuous values each market is its own tier and
   the existing descending sort already serves the hottest need first.
   Cooling deposits are ordinary grows in the waterfill (accepted).
8. **PRIMARY fill gets a utilization floor** (the one PRIMARY change, see
   "Sleeve full" below): the fill target is
   `min(effectiveCap, floor(borrow × 100 / PRIMARY_MIN_UTIL_PERCENT))`
   expressed as a market supply total, converted to a vault delta exactly
   like a steered target. Deposit-time guard only: a position already
   above it holds (`R-HOLD`), it is never a withdrawal trigger.

Untouched: PRIMARY fill-to-cap (PT-sUSDS), cap-breach priority
withdrawals, RETIRED markets, 15–20% sleeve, pre-flight checks, `bps`
fallback, `DRY_RUN`, `BOT_PAUSED`, SSR/anchor sanity bounds.

## Sleeve full: PRIMARY fill stops at 80% utilization

2026-10-05: sleeve $7.75M = 20.0% of $38.77M — **full to the dollar**.
PT $3.42M at 66% util (borrow $2.26M; cap min($5M, 10%) = $3.88M),
cbBTC $3.01M, wstETH $1.32M. The rate loop wants cbBTC +$35k and
wstETH +$30k (92% → 91.0% / 90.4%) and there is no budget, because the
PRIMARY fill takes every freed dollar first regardless of PT demand.

Rule (agreed 2026-10-05): PT stays PRIMARY — no band, no rate target,
served first — but **a deposit into PT must not push its utilization
below `PRIMARY_MIN_UTIL_PERCENT` (new env, default 80)**. Fill target
`= min(cap, borrow / 0.80)`. With borrow $2.26M that is $2.83M, so PT
asks for nothing today and will not absorb budget freed by HEAT
withdrawals; that budget stays idle inside the sleeve and funds later
COOL deposits in cbBTC / wstETH. PT grows again only as its own borrow
grows (looper demand), which is what a PRIMARY bucket should track.

Deposit-time guard only: PT's current $590k excess above $2.83M is not
withdrawn, so room appears gradually (steered HEAT withdrawals, PT borrow
growth), not today. If immediate room is wanted, the same floor can also
act as a cap (priority withdrawal down to `borrow / 0.80`, frees ~$590k
at once) — a one-line extension, **off by default, decide explicitly**.

## Config — no env change needed on Railway

| knob | status | default |
|---|---|---|
| `RATE_MARGIN_BPS` | new, optional | 60 |
| `RATE_MARGIN_<MARKET>_BPS` | new, optional | unset = global |
| `UTIL_MIN_BPS` / `UTIL_MAX_BPS` | new, optional | 8000 / 9500 |
| `PRIMARY_MIN_UTIL_PERCENT` | new, optional | 80 (PT fill never pushes PT util below it; percent, like `LIQUIDITY_RESERVE_PERCENT`) |
| `SSR_T_MARGIN_BPS`, `SSR_T_MARGIN_<MARKET>_BPS`, `SSR_T_TOLERANCE_BPS` | retired — ignored, warn at startup if set | — |
| everything else (`ALLOCATION_MODE=bands`, `MODE_*`, `CAP_*`, `MAX_*`, deadband, min action, cooldown, share) | unchanged | — |

## Precision with the $10k step (accepted)

| market (2026-10-05) | $10k = | rate precision |
|---|---|---|
| cbBTC ($3.0M supply) | 0.3 pp util | ~±30 bps |
| wstETH ($1.3M supply) | 0.7 pp util | ~±80 bps |

Shrinks as markets grow. Borrower moves of ~$50k shift the rate ~50 bps
between cycles anyway; the anchor only reacts to the time average. Treat
SSR + 50–70 bps as an aim point, not a guarantee.

## Deliverables

- `band-controller.ts`: replace `pickBand` ladder + satAPY zone with
  steps 2–5; `BandRule` gains `R-HEAT|R-REST|R-COOL`, drops `R-BAND*`.
- `band-config.ts`: new optional knobs with code defaults (incl.
  `PRIMARY_MIN_UTIL_PERCENT=80`); retired knobs parsed only to warn. No
  new required env.
- `band-controller.ts` PRIMARY branch: fill target capped at
  `borrow / PRIMARY_MIN_UTIL_PERCENT` (step 8); tests for at/above/below
  the floor and for the cap-vs-floor minimum.
- Tests: inverse-curve round trip vs SDK, regime/clamp cases, gates
  unchanged (`band-controller.test.ts`, `band-config.test.ts`).
- `docs/band-steering.md` + `usds-flagship/README.md` updated (also fix
  the stale "every 6 hours" crontab line; cadence is hourly).
- Trace: `BAND_TRACE` records `targetRate`, `anchorApy`, `targetUtilBps`,
  regime. Grep any trace consumers for `R-BAND` before renaming.

## Rollout

Shadow (`DRY_RUN=true`) next to the live bot, grade traces; replay the
last 30 days on `fork-sim.ts`; PR needs Soter-side approval; `bps` mode
stays the instant rollback.
