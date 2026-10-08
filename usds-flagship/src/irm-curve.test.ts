import { describe, it, expect } from 'vitest';
import { AdaptiveCurveIrmLib, MarketUtils } from '@morpho-org/blue-sdk';
import { apyToPerSecWad, borrowApyAtUtilization, utilizationBpsForBorrowApy } from './irm-curve.js';

const WAD = 10n ** 18n;
const utilWad = (fraction: number) => BigInt(Math.round(fraction * 10000)) * WAD / 10000n;

// Production shape on 2026-10-05: SSR 3.60% -> target 4.20% at a 60 bps margin.
const TARGET_4_20 = 0.042;

describe('apyToPerSecWad', () => {
  it('is the inverse of the SDK rateToApy convention to within the wei rounding of the rate', () => {
    // A 0.1% APY is ~3.2e7 wei per second, so rounding the rate to a wei moves the
    // APY by ~3e-11; nothing downstream resolves below a basis point.
    for (const apy of [0.001, 0.0352, 0.042, 0.1, 6.39]) {
      expect(MarketUtils.rateToApy(apyToPerSecWad(apy, 'apy'))).toBeCloseTo(apy, 9);
    }
  });

  it('throws on a zero, negative or non-finite APY instead of pricing a phantom market', () => {
    expect(() => apyToPerSecWad(0, 'anchor')).toThrow(/anchor: APY must be a positive finite number/);
    expect(() => apyToPerSecWad(-0.01, 'anchor')).toThrow(/anchor/);
    expect(() => apyToPerSecWad(Number.NaN, 'anchor')).toThrow(/anchor/);
  });
});

describe('utilizationBpsForBorrowApy', () => {
  it('prices cbBTC/USDS of 2026-10-05 (anchor 3.26%) at SSR + 60 bps just under 91% utilization', () => {
    // The brief's worked example: the rate loop wants 92% -> 91.0%.
    expect(utilizationBpsForBorrowApy(TARGET_4_20, 0.0326)).toBe(9094);
  });

  it('prices wstETH/USDS of 2026-10-05 (anchor 3.75%) at SSR + 60 bps at 90.4% utilization', () => {
    expect(utilizationBpsForBorrowApy(TARGET_4_20, 0.0375)).toBe(9039);
  });

  it('returns the 90% rest point when the anchor already equals the target', () => {
    expect(utilizationBpsForBorrowApy(0.042, 0.042)).toBe(9000);
  });

  it('cools below 90% when the anchor is above the target', () => {
    // anchor 4.6% vs target 4.12%: 0.9 + 0.9 x (ratio - 1) / 0.75 in rate space.
    expect(utilizationBpsForBorrowApy(0.0412, 0.046)).toBe(7773);
  });

  it('saturates at 100% when the target is beyond 4 x anchor', () => {
    expect(utilizationBpsForBorrowApy(0.2, 0.01)).toBe(10000);
  });

  it('saturates at 0% when the target is under anchor / 4', () => {
    expect(utilizationBpsForBorrowApy(0.001, 0.05)).toBe(0);
  });

  it('round-trips through the SDK forward curve at zero elapsed time', () => {
    // The inverse is exact in per-second WAD space (the curve is piecewise linear
    // there); the public API rounds utilization to a bps, which moves the rate by
    // at most ~0.5 bps x 30 x anchor above 90% — under 1 bps for every anchor the
    // sanity bounds admit at a 1-20% target.
    for (const anchor of [0.0148, 0.0215, 0.0326, 0.0375, 0.046, 0.08]) {
      for (const target of [0.0352, 0.0412, 0.042, 0.06]) {
        const utilBps = utilizationBpsForBorrowApy(target, anchor);
        if (utilBps <= 0 || utilBps >= 10000) continue;
        const back = borrowApyAtUtilization(anchor, BigInt(utilBps) * WAD / 10000n);
        expect(Math.abs(back - target) * 10000).toBeLessThan(1);
      }
    }
  });

  it('agrees with the SDK inverse to the wei before rounding (documents the exactness claim)', () => {
    const anchor = apyToPerSecWad(0.023, 'anchor');
    const target = apyToPerSecWad(0.0412, 'target');
    const utilization = AdaptiveCurveIrmLib.getUtilizationAtBorrowRate(target, anchor);
    const back = AdaptiveCurveIrmLib.getBorrowRate(utilization, anchor, 0n).endBorrowRate;
    expect(back >= target - 1n && back <= target + 1n).toBe(true);
  });
});

describe('borrowApyAtUtilization', () => {
  it('charges the anchor itself at the 90% target utilization', () => {
    expect(borrowApyAtUtilization(0.0352, utilWad(0.9))).toBeCloseTo(0.0352, 10);
  });

  it('charges 4 x the anchor rate at 100% utilization — (1 + anchor)^4 - 1 in APY', () => {
    expect(borrowApyAtUtilization(0.0352, WAD)).toBeCloseTo(1.0352 ** 4 - 1, 10);
  });

  it('charges a quarter of the anchor rate in an empty market — (1 + anchor)^0.25 - 1 in APY', () => {
    expect(borrowApyAtUtilization(0.0352, 0n)).toBeCloseTo(1.0352 ** 0.25 - 1, 10);
  });

  it('reproduces the brief: cbBTC at 92% / anchor 3.26% pays ~5.3%, wstETH at 92% / 3.75% pays ~6.1%', () => {
    expect(borrowApyAtUtilization(0.0326, utilWad(0.92))).toBeCloseTo(0.0527, 4);
    expect(borrowApyAtUtilization(0.0375, utilWad(0.92))).toBeCloseTo(0.0607, 4);
  });

  it('throws on a utilization outside [0, 100%]', () => {
    expect(() => borrowApyAtUtilization(0.0352, WAD + 1n)).toThrow(/outside \[0, 1e18\]/);
    expect(() => borrowApyAtUtilization(0.0352, -1n)).toThrow(/outside \[0, 1e18\]/);
  });

  it('throws on a zero anchor instead of pricing it as a brand-new market', () => {
    expect(() => borrowApyAtUtilization(0, utilWad(0.9))).toThrow(/anchor/);
  });
});
