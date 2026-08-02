import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { reconcileToVaultLimits, spotSupplyApy, type ReconcileMarket } from './reconcile.js';

// Production-scale vault: 35M totalAssets -> sleeve cap 20% = 7M, floor 15% = 5.25M.
const TOTAL_ASSETS = parseEther('35000000');

/** cbBTC/USDS-like leg: 4.2M supply, 3.72M borrow, anchor 2.30%, band 93. */
function leg(overrides: Partial<ReconcileMarket> & { index: number }): ReconcileMarket {
  return {
    name: 'cbBTC/USDS',
    delta: 0n,
    bandUtilBps: 9300,
    totalSupplyAssets: parseEther('4200000'),
    totalBorrowAssets: parseEther('3720000'),
    anchorApy: 0.023,
    ...overrides,
  };
}

function reconcile(markets: ReconcileMarket[], sleeveUsds: bigint) {
  return reconcileToVaultLimits({
    markets,
    sleeveUsds,
    totalAssets: TOTAL_ASSETS,
    sleeveFloorBps: 1500,
    sleeveCapBps: 2000,
    minActionUsds: parseEther('100000'),
  });
}

describe('spotSupplyApy (Adaptive Curve IRM shape)', () => {
  it('equals satAPY (0.9 x anchor) at the 90% target utilization', () => {
    expect(spotSupplyApy(0.04, parseEther('4000000'), parseEther('3600000'))).toBeCloseTo(0.036, 10);
  });

  it('reaches 4 x anchor at full utilization', () => {
    expect(spotSupplyApy(0.04, parseEther('1000000'), parseEther('1000000'))).toBeCloseTo(0.16, 10);
  });

  it('is zero for an empty market', () => {
    expect(spotSupplyApy(0.04, 0n, 0n)).toBe(0);
  });
});

describe('sleeve inside the limits', () => {
  it('passes every wish through untouched', () => {
    // Given a 6M sleeve, +300k and -200k land at 6.1M — inside [5.25M, 7M].
    const legs = reconcile([
      leg({ index: 0, delta: parseEther('300000') }),
      leg({ index: 1, delta: -parseEther('200000') }),
    ], parseEther('6000000'));

    expect(legs[0].delta).toBe(parseEther('300000'));
    expect(legs[1].delta).toBe(-parseEther('200000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].note).toBeUndefined();
  });

  it('does not cut a batch landing exactly on the 20% cap', () => {
    // 6.5M sleeve + 500k deposit = 7.0M, exactly the cap.
    const legs = reconcile([leg({ index: 0, delta: parseEther('500000') })], parseEther('6500000'));

    expect(legs[0].delta).toBe(parseEther('500000'));
    expect(legs[0].note).toBeUndefined();
  });
});

describe('deposits over the 20% cap (waterfilling)', () => {
  it('credits same-batch withdrawals to the deposit budget', () => {
    // Sleeve already at the 7M cap; a 600k withdrawal frees exactly 600k of budget
    // for the 900k deposit wish.
    const legs = reconcile([
      leg({ index: 0, delta: parseEther('900000'), totalSupplyAssets: parseEther('3600000'), totalBorrowAssets: parseEther('3600000') }),
      leg({ index: 1, delta: -parseEther('600000'), bandUtilBps: 9500 }),
    ], parseEther('7000000'));

    expect(legs[0].delta).toBeGreaterThanOrEqual(parseEther('599999'));
    expect(legs[0].delta).toBeLessThanOrEqual(parseEther('600000'));
    expect(legs[0].note).toMatch(/sleeve cap/);
    expect(legs[1].delta).toBe(-parseEther('600000'));
  });

  it('routes the whole budget to the market that earns most when the rate gap is wide', () => {
    // A: pinned at 100% util with a heated 4.6% anchor — spot 18.4%, still ~4% after
    // taking the full budget. B: at the 90% target with a 2% anchor — spot 1.8%.
    // Budget 200k (6.8M sleeve, cap 7M): every dollar belongs to A.
    const legs = reconcile([
      leg({ index: 0, name: 'PT-sUSDS/USDS', delta: parseEther('500000'), anchorApy: 0.046, totalSupplyAssets: parseEther('3600000'), totalBorrowAssets: parseEther('3600000') }),
      leg({ index: 1, delta: parseEther('500000'), anchorApy: 0.02, totalSupplyAssets: parseEther('4000000'), totalBorrowAssets: parseEther('3600000') }),
    ], parseEther('6800000'));

    expect(legs[0].delta).toBeGreaterThanOrEqual(parseEther('199999'));
    expect(legs[0].delta).toBeLessThanOrEqual(parseEther('200000'));
    expect(legs[1].delta).toBe(0n);
  });

  it('splits the budget so both markets land on one common spot rate', () => {
    // Two fully-utilized markets with the SAME anchor: equal post-fill spot rate means
    // equal post-fill utilization, so the 400k budget (6.6M sleeve, cap 7M) splits
    // proportionally to borrow — 3M:2M -> 240k:160k.
    const legs = reconcile([
      leg({ index: 0, delta: parseEther('400000'), anchorApy: 0.03, totalSupplyAssets: parseEther('3000000'), totalBorrowAssets: parseEther('3000000') }),
      leg({ index: 1, delta: parseEther('400000'), anchorApy: 0.03, totalSupplyAssets: parseEther('2000000'), totalBorrowAssets: parseEther('2000000') }),
    ], parseEther('6600000'));

    expect(legs[0].delta).toBeGreaterThanOrEqual(parseEther('239998'));
    expect(legs[0].delta).toBeLessThanOrEqual(parseEther('240001'));
    expect(legs[1].delta).toBeGreaterThanOrEqual(parseEther('159998'));
    expect(legs[1].delta).toBeLessThanOrEqual(parseEther('160001'));
    expect(legs[0].delta + legs[1].delta).toBeLessThanOrEqual(parseEther('400000'));
  });

  it('drops a deposit the cap squeezes below the 100k min action', () => {
    // Budget 90k (6.91M sleeve, cap 7M): the fill lands under the min action.
    const legs = reconcile([
      leg({ index: 0, delta: parseEther('500000'), totalSupplyAssets: parseEther('3600000'), totalBorrowAssets: parseEther('3600000') }),
    ], parseEther('6910000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/min action/);
  });
});

describe('withdrawals under the 15% floor (band tiers, deepest first)', () => {
  it('serves whole tiers from the deepest band and drops the shallowest', () => {
    // Budget 650k (5.9M sleeve, floor 5.25M): tier 95 (400k) passes whole, tier 93
    // gets the remaining 250k, tier 92 waits for the next cycle.
    const legs = reconcile([
      leg({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500 }),
      leg({ index: 1, delta: -parseEther('300000'), bandUtilBps: 9300 }),
      leg({ index: 2, delta: -parseEther('500000'), bandUtilBps: 9200 }),
    ], parseEther('5900000'));

    expect(legs[0].delta).toBe(-parseEther('400000'));
    expect(legs[1].delta).toBe(-parseEther('250000'));
    expect(legs[2].delta).toBe(0n);
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].note).toMatch(/sleeve floor/);
    expect(legs[2].note).toMatch(/sleeve floor/);
  });

  it('lands every market of the marginal tier on one common utilization', () => {
    // One 9500 tier, budget 300k (5.55M sleeve, floor 5.25M). Pooled 3.3M supply /
    // 2.7M borrow minus the budget -> common util 90%: market A (1.8M borrow) is cut
    // to 2.0M supply (-100k), market B (0.9M borrow) to 1.0M supply (-200k).
    const legs = reconcile([
      leg({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('2100000'), totalBorrowAssets: parseEther('1800000') }),
      leg({ index: 1, delta: -parseEther('500000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('1200000'), totalBorrowAssets: parseEther('900000') }),
    ], parseEther('5550000'));

    expect(legs[0].delta).toBe(-parseEther('100000'));
    expect(legs[1].delta).toBe(-parseEther('200000'));
  });

  it('credits planned deposits to the withdrawal budget and lands exactly on the floor', () => {
    // Sleeve 5.4M, floor 5.25M: alone the budget is 150k, but the +200k deposit lifts
    // it to 350k. Post-batch sleeve: 5.4M - 350k + 200k = 5.25M — the floor holds.
    const legs = reconcile([
      leg({ index: 0, delta: parseEther('200000') }),
      leg({ index: 1, delta: -parseEther('800000'), bandUtilBps: 9500 }),
    ], parseEther('5400000'));

    expect(legs[0].delta).toBe(parseEther('200000'));
    expect(legs[1].delta).toBe(-parseEther('350000'));
  });

  it('drops a withdrawal the floor squeezes below the 100k min action', () => {
    // Budget 50k (5.3M sleeve, floor 5.25M): the cut lands under the min action.
    const legs = reconcile([
      leg({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500 }),
    ], parseEther('5300000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/min action/);
  });
});
