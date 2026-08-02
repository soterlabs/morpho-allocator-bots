import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { reconcileToVaultLimits, type ReconcileMarket } from './reconcile.js';

// Production-scale vault: 35M totalAssets -> sleeve cap 20% = 7M, floor 15% = 5.25M.
const TOTAL_ASSETS = parseEther('35000000');

/** cbBTC/USDS-like wish: 4.2M supply, 3.72M borrow, anchor 2.30%, band 93. */
function wish(overrides: Partial<ReconcileMarket> & { index: number }): ReconcileMarket {
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

describe('sleeve inside the limits', () => {
  it('passes every wish through untouched', () => {
    // Given a 6M sleeve, +300k and -200k land at 6.1M — inside [5.25M, 7M].
    const legs = reconcile([
      wish({ index: 0, delta: parseEther('300000') }),
      wish({ index: 1, delta: -parseEther('200000') }),
    ], parseEther('6000000'));

    expect(legs[0].delta).toBe(parseEther('300000'));
    expect(legs[1].delta).toBe(-parseEther('200000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].note).toBeUndefined();
  });

  it('does not cut a batch landing exactly on the 20% cap', () => {
    // 6.5M sleeve + 500k deposit = 7.0M, exactly the cap.
    const legs = reconcile([wish({ index: 0, delta: parseEther('500000') })], parseEther('6500000'));

    expect(legs[0].delta).toBe(parseEther('500000'));
    expect(legs[0].note).toBeUndefined();
  });
});

describe('deposits over the 20% cap (waterfilling)', () => {
  it('credits same-batch withdrawals to the deposit budget', () => {
    // Sleeve already at the 7M cap; a 600k withdrawal frees exactly 600k of budget
    // for the 900k deposit wish.
    const legs = reconcile([
      wish({ index: 0, delta: parseEther('900000'), totalSupplyAssets: parseEther('3600000'), totalBorrowAssets: parseEther('3600000') }),
      wish({ index: 1, delta: -parseEther('600000'), bandUtilBps: 9500 }),
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
      wish({ index: 0, name: 'PT-sUSDS/USDS', delta: parseEther('500000'), anchorApy: 0.046, totalSupplyAssets: parseEther('3600000'), totalBorrowAssets: parseEther('3600000') }),
      wish({ index: 1, delta: parseEther('500000'), anchorApy: 0.02, totalSupplyAssets: parseEther('4000000'), totalBorrowAssets: parseEther('3600000') }),
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
      wish({ index: 0, delta: parseEther('400000'), anchorApy: 0.03, totalSupplyAssets: parseEther('3000000'), totalBorrowAssets: parseEther('3000000') }),
      wish({ index: 1, delta: parseEther('400000'), anchorApy: 0.03, totalSupplyAssets: parseEther('2000000'), totalBorrowAssets: parseEther('2000000') }),
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
      wish({ index: 0, delta: parseEther('500000'), totalSupplyAssets: parseEther('3600000'), totalBorrowAssets: parseEther('3600000') }),
    ], parseEther('6910000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/min action/);
  });

  it('serves a small wish in full and passes the leftover budget to the next-best market', () => {
    // A (spot 20%) wishes only 100k; even fully filled it still out-earns B (spot 12%),
    // so A takes its whole wish and B gets the remaining 200k of the 300k budget.
    const legs = reconcile([
      wish({ index: 0, delta: parseEther('100000'), anchorApy: 0.05, totalSupplyAssets: parseEther('2000000'), totalBorrowAssets: parseEther('2000000') }),
      wish({ index: 1, delta: parseEther('500000'), anchorApy: 0.03, totalSupplyAssets: parseEther('3000000'), totalBorrowAssets: parseEther('3000000') }),
    ], parseEther('6700000'));

    expect(legs[0].delta).toBe(parseEther('100000'));
    expect(legs[1].delta).toBeGreaterThanOrEqual(parseEther('199999'));
    expect(legs[1].delta).toBeLessThanOrEqual(parseEther('200000'));
  });

  it('cuts every deposit to zero when the sleeve already sits above the cap', () => {
    // Sleeve 7.3M with no withdrawals: the deposit budget clamps to zero.
    const legs = reconcile([wish({ index: 0, delta: parseEther('300000') })], parseEther('7300000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/sleeve cap/);
  });

  it('fills nothing when every deposit market earns a zero spot rate', () => {
    // A borrow-less market pays nothing — there is no "earns most" to rank by.
    const legs = reconcile([
      wish({ index: 0, delta: parseEther('500000'), totalBorrowAssets: 0n }),
    ], parseEther('6800000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/sleeve cap/);
  });
});

describe('withdrawals under the 15% floor (band tiers, deepest first)', () => {
  it('serves whole tiers from the deepest band and drops the shallowest', () => {
    // Budget 650k (5.9M sleeve, floor 5.25M): tier 95 (400k) passes whole, tier 93
    // gets the remaining 250k, tier 92 waits for the next cycle.
    const legs = reconcile([
      wish({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500 }),
      wish({ index: 1, delta: -parseEther('300000'), bandUtilBps: 9300 }),
      wish({ index: 2, delta: -parseEther('500000'), bandUtilBps: 9200 }),
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
      wish({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('2100000'), totalBorrowAssets: parseEther('1800000') }),
      wish({ index: 1, delta: -parseEther('500000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('1200000'), totalBorrowAssets: parseEther('900000') }),
    ], parseEther('5550000'));

    expect(legs[0].delta).toBe(-parseEther('100000'));
    expect(legs[1].delta).toBe(-parseEther('200000'));
  });

  it('credits planned deposits to the withdrawal budget and lands exactly on the floor', () => {
    // Sleeve 5.4M, floor 5.25M: alone the budget is 150k, but the +200k deposit lifts
    // it to 350k. Post-batch sleeve: 5.4M - 350k + 200k = 5.25M — the floor holds.
    const legs = reconcile([
      wish({ index: 0, delta: parseEther('200000') }),
      wish({ index: 1, delta: -parseEther('800000'), bandUtilBps: 9500 }),
    ], parseEther('5400000'));

    expect(legs[0].delta).toBe(parseEther('200000'));
    expect(legs[1].delta).toBe(-parseEther('350000'));
  });

  it('drops a withdrawal the floor squeezes below the 100k min action', () => {
    // Budget 50k (5.3M sleeve, floor 5.25M): the cut lands under the min action.
    const legs = reconcile([
      wish({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500 }),
    ], parseEther('5300000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/min action/);
  });

  it('keeps the floor when a tier member already sits above the common utilization', () => {
    // Budget 150k (5.4M sleeve, floor 5.25M). B (util 95%) sits above any common
    // utilization the budget allows, so it takes no cut and leaves the pool; A alone
    // is then cut to exactly the budget. Post-batch sleeve: 5.4M - 150k = 5.25M.
    const legs = reconcile([
      wish({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('2000000'), totalBorrowAssets: parseEther('1000000') }),
      wish({ index: 1, delta: -parseEther('150000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('1000000'), totalBorrowAssets: parseEther('950000') }),
    ], parseEther('5400000'));

    expect(legs[0].delta).toBe(-parseEther('150000'));
    expect(legs[1].delta).toBe(0n);
  });

  it('serves a shallow wish in full and re-levels the rest of the tier on the leftover', () => {
    // Budget 300k (5.55M sleeve, floor 5.25M). The common level wants 650k from A,
    // far past its 100k wish: A is served at the wish and B is re-cut against the
    // remaining 200k — the full budget is used.
    const legs = reconcile([
      wish({ index: 0, delta: -parseEther('100000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('3000000'), totalBorrowAssets: parseEther('1500000') }),
      wish({ index: 1, delta: -parseEther('600000'), bandUtilBps: 9500, totalSupplyAssets: parseEther('2000000'), totalBorrowAssets: parseEther('1500000') }),
    ], parseEther('5550000'));

    expect(legs[0].delta).toBe(-parseEther('100000'));
    expect(legs[1].delta).toBe(-parseEther('200000'));
  });

  it('serves a borrow-less tier in wish order until the budget runs out', () => {
    // Budget 500k (5.75M sleeve, floor 5.25M): with no borrows there is no common
    // utilization to land on — A takes its full 300k, B the remaining 200k.
    const legs = reconcile([
      wish({ index: 0, delta: -parseEther('300000'), bandUtilBps: 9500, totalBorrowAssets: 0n }),
      wish({ index: 1, delta: -parseEther('400000'), bandUtilBps: 9500, totalBorrowAssets: 0n }),
    ], parseEther('5750000'));

    expect(legs[0].delta).toBe(-parseEther('300000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].delta).toBe(-parseEther('200000'));
    expect(legs[1].note).toMatch(/sleeve floor/);
  });

  it('cuts every withdrawal to zero when the sleeve already sits below the floor', () => {
    // Sleeve 5.2M with no deposits: the withdrawal budget clamps to zero.
    const legs = reconcile([
      wish({ index: 0, delta: -parseEther('400000'), bandUtilBps: 9500 }),
    ], parseEther('5200000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/sleeve floor/);
  });

  it('passes zero-delta legs (HOLD / RETIRED markets) through while siblings are cut', () => {
    const legs = reconcile([
      wish({ index: 0, delta: 0n, bandUtilBps: undefined }),
      wish({ index: 1, delta: -parseEther('800000'), bandUtilBps: 9500 }),
    ], parseEther('5400000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].delta).toBe(-parseEther('150000'));
  });
});
