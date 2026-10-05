/**
 * Adaptive Curve IRM rate curve, in both directions, for the band controller.
 *
 * Pure module: no RPC, no env. The controller steers each market to the utilization
 * at which its CURRENT borrow rate equals a target (SSR + margin), so it needs the
 * curve forward (what does the market pay at this utilization?) and inverted (at
 * which utilization would it pay the target?). Both are delegated to
 * @morpho-org/blue-sdk's AdaptiveCurveIrmLib — the JS port of the on-chain contract —
 * at zero elapsed time, so nothing here reimplements the curve; this module only
 * converts between the controller's APY fractions and the IRM's per-second WAD rates.
 *
 * Curve recap (CURVE_STEEPNESS 4, TARGET_UTILIZATION 90%): borrowRate = anchor x
 * curve(err) with err = (u - 0.9) / 0.1 above the target and (u - 0.9) / 0.9 below,
 * curve = 1 + 3 x err above and 1 + 0.75 x err below. The curve is linear in the
 * PER-SECOND rate, not in APY, so every conversion goes through the SDK's own
 * continuous-compounding convention (rateToApy = expm1(rate x secondsPerYear)) and
 * its exact inverse — a borrow APY of 4.12% against an anchor APY of 2.30% inverts to
 * the utilization the contract would actually price at 4.12%, not to a linear-in-APY
 * approximation of it.
 */
import { AdaptiveCurveIrmLib, MarketUtils, MathLib, SECONDS_PER_YEAR } from '@morpho-org/blue-sdk';

const BPS_PER_WAD = MathLib.WAD / 10000n;

/**
 * Per-second WAD rate whose continuously compounded APY is `apy` — the exact inverse
 * of MarketUtils.rateToApy. Throws on a non-positive APY: the IRM clamps rateAtTarget
 * to >= 0.1% APR on-chain, so a zero or negative anchor is a corrupted read, and the
 * SDK would silently price a zero rateAtTarget as a brand-new market (4% APR).
 */
export function apyToPerSecWad(apy: number, label: string): bigint {
  if (!Number.isFinite(apy) || apy <= 0) {
    throw new Error(`${label}: APY must be a positive finite number, got ${apy}`);
  }
  return BigInt(Math.round((Math.log1p(apy) * 1e18) / Number(SECONDS_PER_YEAR)));
}

/**
 * Utilization (bps, rounded to the nearest bps) at which a market with the given
 * anchor (rateAtTarget) APY charges exactly `targetBorrowApy`, on the Adaptive Curve
 * IRM at zero elapsed time. Unreachable targets saturate at the curve's ends: a target
 * above 4 x anchor reads 10000, a target below anchor / 4 reads 0 — callers clamp to
 * their own operating range.
 */
export function utilizationBpsForBorrowApy(targetBorrowApy: number, anchorApy: number): number {
  const utilizationWad = AdaptiveCurveIrmLib.getUtilizationAtBorrowRate(
    apyToPerSecWad(targetBorrowApy, 'target borrow'),
    apyToPerSecWad(anchorApy, 'anchor'),
  );
  return Number((utilizationWad + BPS_PER_WAD / 2n) / BPS_PER_WAD);
}

/**
 * Borrow APY a market with the given anchor APY charges at `utilizationWad` (1e18 =
 * 100%) right now — the curve at zero elapsed time, so the anchor does not drift.
 */
export function borrowApyAtUtilization(anchorApy: number, utilizationWad: bigint): number {
  if (utilizationWad < 0n || utilizationWad > MathLib.WAD) {
    throw new Error(`borrowApyAtUtilization: utilizationWad ${utilizationWad} outside [0, 1e18]`);
  }
  const { endBorrowRate } = AdaptiveCurveIrmLib.getBorrowRate(
    utilizationWad, apyToPerSecWad(anchorApy, 'anchor'), 0n,
  );
  return MarketUtils.rateToApy(endBorrowRate);
}
