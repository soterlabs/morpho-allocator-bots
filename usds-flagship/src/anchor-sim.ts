/**
 * Anchor (rateAtTarget) projection for the Morpho Adaptive Curve IRM.
 *
 * Pure module: no RPC, no env. The band controller's A/B borrower-reaction
 * bracket (log-only in v1) uses this to project where a market's anchor rate
 * drifts if the vault holds it at a given utilization — e.g. "hold util at
 * 94% for 24h and the anchor rises to X% APY".
 *
 * All IRM math is delegated to @morpho-org/blue-sdk's AdaptiveCurveIrmLib
 * (the JS port of morpho-blue-irm's AdaptiveCurveIrm / ExpLib, byte-exact
 * with the on-chain contract). This module only folds that primitive over
 * caller-supplied utilization segments; nothing here reimplements the curve.
 *
 * Mechanics recap: the anchor adapts as
 *   rateAtTarget(t+T) = clamp(rateAtTarget(t) * wExp(speed * err * T), MIN, MAX)
 * where err is the normalized utilization error (+1 at 100% util, 0 at the
 * 90% target, -1 at 0%) and speed = 50/year — so at full positive error the
 * anchor doubles roughly every 5 days (ln 2 / 50 years ≈ 5.06 d).
 */
import { AdaptiveCurveIrmLib, MarketUtils, MathLib, SECONDS_PER_YEAR } from '@morpho-org/blue-sdk';

/**
 * One leg of a projected utilization path: the market sits at `utilizationWad`
 * (WAD-scaled, 1e18 = 100%) for `durationSec` seconds.
 */
export interface UtilSegment {
  utilizationWad: bigint;
  durationSec: bigint;
}

/**
 * Fold the Adaptive Curve IRM anchor adaptation over an explicit utilization
 * path and return the end rateAtTarget (per-second, WAD-scaled).
 *
 * Each segment is one call to AdaptiveCurveIrmLib.getBorrowRate — exactly one
 * hypothetical on-chain accrual at the segment's utilization for the segment's
 * duration — and the resulting endRateAtTarget seeds the next segment. The
 * result is clamped to [MIN_RATE_AT_TARGET, MAX_RATE_AT_TARGET] by the SDK at
 * every step, matching the contract.
 *
 * SEGMENTATION IS SEMANTICS, NOT A DETAIL. The IRM's wExp is a chunked
 * 2nd-order Taylor approximation (x decomposed as q·ln2 + r, e^r ≈ 1 + r +
 * r²/2), and each step rounds down through wMulDown, so
 * simulateAnchor(r, [7 days]) !== simulateAnchor(r, [1 day] × 7) even at
 * constant utilization — exactly as seven daily on-chain accruals differ from
 * one weekly accrual. Callers must pass the segments they actually mean (one
 * per expected accrual cadence / utilization regime); this function NEVER
 * merges or splits them. The drift is small (~1e-4 relative over a week at
 * full error) but nonzero, and tests pin its existence.
 *
 * Fail-loud validation:
 * - anchorStartPerSecWad must be > 0. The SDK treats 0 as "first interaction"
 *   and silently substitutes INITIAL_RATE_AT_TARGET, which would mask an
 *   upstream read failure (e.g. a zeroed rateAtTarget from a bad RPC decode).
 * - utilizationWad must be within [0, WAD]; durationSec must be >= 0.
 *
 * An empty segment list is the identity (returns the start anchor unchanged).
 * A zero-duration segment is likewise a no-op, mirroring the contract
 * (linearAdaptation = 0 keeps the rate unchanged).
 *
 * @param anchorStartPerSecWad Current rateAtTarget, per-second WAD-scaled
 *   (as read from the IRM / Market state).
 * @param segments Explicit utilization path, applied in order.
 * @returns End rateAtTarget, per-second WAD-scaled.
 */
export function simulateAnchor(anchorStartPerSecWad: bigint, segments: UtilSegment[]): bigint {
  if (anchorStartPerSecWad <= 0n) {
    throw new Error(
      `simulateAnchor: anchorStartPerSecWad must be > 0, got ${anchorStartPerSecWad} ` +
      '(the SDK would silently substitute INITIAL_RATE_AT_TARGET for 0)',
    );
  }
  let rateAtTarget = anchorStartPerSecWad;
  for (const [i, seg] of segments.entries()) {
    if (seg.utilizationWad < 0n || seg.utilizationWad > MathLib.WAD) {
      throw new Error(`simulateAnchor: segment ${i} utilizationWad ${seg.utilizationWad} outside [0, 1e18]`);
    }
    if (seg.durationSec < 0n) {
      throw new Error(`simulateAnchor: segment ${i} durationSec ${seg.durationSec} is negative`);
    }
    rateAtTarget = AdaptiveCurveIrmLib.getBorrowRate(seg.utilizationWad, rateAtTarget, seg.durationSec).endRateAtTarget;
  }
  return rateAtTarget;
}

/**
 * Clamped projected utilization for the log-only A/B borrower-reaction
 * bracket: utilization (WAD, 1e18 = 100%) of a market whose supply is
 * `postSupplyAssets` and borrow is `totalBorrowAssets`, clamped into
 * simulateAnchor's [0, WAD] domain.
 *
 * Why the clamp exists: the bracket projects post-trade utilization from the
 * RAW decision delta, but a cap- or floor-forced
 * drain can target more than the pool's idle liquidity, making
 * postSupply < borrow and the raw division exceed WAD. The REAL post-trade
 * utilization can never exceed 100% — the on-chain withdraw is
 * liquidity-capped — so WAD is the truthful projection for that case, and a
 * diagnostics-only projection must never be able to abort the cycle by
 * feeding simulateAnchor an out-of-domain value.
 *
 * postSupply <= 0 (the projected withdraw removes the whole supply) projects
 * 100% while any borrow remains — the vault WAS the supply, so whatever
 * liquidity-capped withdraw actually executes leaves the market maximally
 * utilized — and 0% only for a genuinely empty market (no borrow either).
 */
export function postTradeUtilizationWad(postSupplyAssets: bigint, totalBorrowAssets: bigint): bigint {
  if (postSupplyAssets <= 0n) return totalBorrowAssets > 0n ? MathLib.WAD : 0n;
  const raw = (totalBorrowAssets * MathLib.WAD) / postSupplyAssets;
  return raw > MathLib.WAD ? MathLib.WAD : raw;
}

/**
 * Convert a per-second WAD-scaled rate (e.g. a rateAtTarget from
 * simulateAnchor) to an APY fraction (0.0247 = 2.47%), using the SDK's own
 * continuous-compounding convention: expm1(rate · SECONDS_PER_YEAR). This is
 * MarketUtils.rateToApy verbatim, re-exported here so band code has one
 * import surface for anchor math.
 */
export function anchorPerSecWadToApy(perSecWad: bigint): number {
  return MarketUtils.rateToApy(perSecWad);
}

/**
 * Plain-number twin of {@link anchorPerSecWadToApy}: annualize a per-second
 * rate already expressed as a float (0.04 / 31536000 for 4% APR) into an APY
 * fraction under the same continuous-compounding convention. Handy when a
 * rate has already left bigint land (e.g. scaling an anchor APY estimate);
 * for WAD bigints prefer anchorPerSecWadToApy, which formats via the SDK.
 */
export function apyFraction(perSecRate: number): number {
  return Math.expm1(perSecRate * Number(SECONDS_PER_YEAR));
}
