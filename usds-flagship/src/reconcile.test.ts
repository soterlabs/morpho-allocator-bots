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
    priority: false,
    primary: false,
    bandUtilBps: 9300,
    totalSupplyAssets: parseEther('4200000'),
    totalBorrowAssets: parseEther('3720000'),
    anchorApy: 0.023,
    ...overrides,
  };
}

/**
 * The suite's global drop threshold is 100k so a floor/cap cut visibly lands a leg
 * under it; the production value comes from BandConfig, not from reconciliation.
 */
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

/**
 * PT-sUSDS/USDS-like PRIMARY wish: 2.415M supply, 2.198M borrow, anchor 2.93% —
 * spot ~3.5%, far under a heated bluechip market's spot, so waterfilling alone
 * would never pick it.
 */
function primaryWish(overrides: Partial<ReconcileMarket> & { index: number }): ReconcileMarket {
  return wish({
    name: 'PT-sUSDS/USDS',
    priority: true,
    primary: true,
    bandUtilBps: undefined,
    totalSupplyAssets: parseEther('2415000'),
    totalBorrowAssets: parseEther('2198000'),
    anchorApy: 0.0293,
    ...overrides,
  });
}

/** Heated cbBTC/USDS: pinned at 100% util with a 4.6% anchor — spot 18.4%. */
function heatedWish(overrides: Partial<ReconcileMarket> & { index: number }): ReconcileMarket {
  return wish({
    anchorApy: 0.046,
    totalSupplyAssets: parseEther('3600000'),
    totalBorrowAssets: parseEther('3600000'),
    ...overrides,
  });
}

describe('priority deposit carve (PRIMARY market) over the 20% cap', () => {
  it('gives the priority deposit the whole budget even though its spot rate is the lowest', () => {
    // Budget 200k (6.8M sleeve, cap 7M). PT spot ~3.5% vs the heated market's 18.4%:
    // waterfilling would send every dollar to the heated market, but PRIMARY is the
    // declared destination, not a yield pick.
    const legs = reconcile([
      primaryWish({ index: 0, delta: parseEther('200000') }),
      heatedWish({ index: 1, delta: parseEther('500000') }),
    ], parseEther('6800000'));

    expect(legs[0].delta).toBe(parseEther('200000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].delta).toBe(0n);
    expect(legs[1].note).toMatch(/waterfilled/);
  });

  it('cuts a priority wish larger than the budget to the budget and leaves the others nothing', () => {
    // Budget 200k (6.8M sleeve, cap 7M) against a 500k PRIMARY wish.
    const legs = reconcile([
      primaryWish({ index: 0, delta: parseEther('500000') }),
      heatedWish({ index: 1, delta: parseEther('500000') }),
    ], parseEther('6800000'));

    expect(legs[0].delta).toBe(parseEther('200000'));
    expect(legs[0].note).toMatch(/priority, served first/);
    expect(legs[1].delta).toBe(0n);
  });

  it('waterfills the remainder after the carve among the ordinary deposits', () => {
    // Budget 400k (6.6M sleeve, cap 7M): PRIMARY takes its 100k off the top; the
    // remaining 300k splits between two same-anchor fully-utilized markets in
    // proportion to borrow — 3M:2M -> 180k:120k.
    const legs = reconcile([
      primaryWish({ index: 0, delta: parseEther('100000') }),
      wish({ index: 1, delta: parseEther('500000'), anchorApy: 0.03, totalSupplyAssets: parseEther('3000000'), totalBorrowAssets: parseEther('3000000') }),
      wish({ index: 2, delta: parseEther('500000'), anchorApy: 0.03, totalSupplyAssets: parseEther('2000000'), totalBorrowAssets: parseEther('2000000') }),
    ], parseEther('6600000'));

    expect(legs[0].delta).toBe(parseEther('100000'));
    expect(legs[1].delta).toBeGreaterThanOrEqual(parseEther('179998'));
    expect(legs[1].delta).toBeLessThanOrEqual(parseEther('180001'));
    expect(legs[2].delta).toBeGreaterThanOrEqual(parseEther('119998'));
    expect(legs[2].delta).toBeLessThanOrEqual(parseEther('120001'));
  });

  it('never lets carve plus waterfill exceed the budget', () => {
    // Budget 400k (6.6M sleeve, cap 7M): 150k carve, then the 250k remainder splits
    // between two same-anchor fully-utilized markets 3.6M:3M -> ~136k:~114k (both
    // above the 100k min action, so no leg is dropped). The three legs must land the
    // sleeve at or under the 7M cap, exactly — the cap is hard.
    const legs = reconcile([
      primaryWish({ index: 0, delta: parseEther('150000') }),
      heatedWish({ index: 1, delta: parseEther('500000') }),
      heatedWish({ index: 2, delta: parseEther('500000'), totalSupplyAssets: parseEther('3000000'), totalBorrowAssets: parseEther('3000000') }),
    ], parseEther('6600000'));

    const filled = legs[0].delta + legs[1].delta + legs[2].delta;
    expect(legs[1].delta).toBeGreaterThan(parseEther('100000'));
    expect(legs[2].delta).toBeGreaterThan(parseEther('100000'));
    expect(filled).toBeLessThanOrEqual(parseEther('400000'));
    expect(filled).toBeGreaterThan(parseEther('399999'));
    expect(parseEther('6600000') + filled).toBeLessThanOrEqual(parseEther('7000000'));
  });

  it('fills the priority deposit even when every ordinary market earns a zero spot rate', () => {
    // Budget 200k (6.8M sleeve, cap 7M). The ordinary market has no borrows, so the
    // waterfill's zero-rate guard fills nothing there — the carve is not ranked by
    // rate and is untouched by that guard.
    const legs = reconcile([
      primaryWish({ index: 0, delta: parseEther('150000') }),
      wish({ index: 1, delta: parseEther('500000'), totalBorrowAssets: 0n }),
    ], parseEther('6800000'));

    expect(legs[0].delta).toBe(parseEther('150000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].delta).toBe(0n);
    expect(legs[1].note).toMatch(/sleeve cap/);
  });

  it('refuses two priority deposits when the cap binds', () => {
    // The carve is defined for one PRIMARY market; a second one is a config bug.
    expect(() => reconcile([
      primaryWish({ index: 0, delta: parseEther('300000') }),
      primaryWish({ index: 1, name: 'cbBTC/USDS', delta: parseEther('300000') }),
    ], parseEther('6800000'))).toThrow(/all carry priority deposits/);
  });

  it('passes the priority deposit and its siblings through untouched when the sleeve fits', () => {
    // 6M sleeve + 500k + 300k = 6.8M — inside [5.25M, 7M], so no carve, no waterfill.
    const legs = reconcile([
      primaryWish({ index: 0, delta: parseEther('500000') }),
      heatedWish({ index: 1, delta: parseEther('300000') }),
    ], parseEther('6000000'));

    expect(legs[0].delta).toBe(parseEther('500000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].delta).toBe(parseEther('300000'));
    expect(legs[1].note).toBeUndefined();
  });
});

/**
 * Cap-breach withdrawal of a STEERED market: no band, priority, judged against the
 * 50k min priority withdrawal.
 */
function breachWish(overrides: Partial<ReconcileMarket> & { index: number }): ReconcileMarket {
  return wish({
    priority: true,
    bandUtilBps: undefined,
    minActionUsds: parseEther('50000'),
    ...overrides,
  });
}

/** Cap-breach withdrawal of the PRIMARY market (PT-sUSDS/USDS above its cap). */
function primaryBreachWish(overrides: Partial<ReconcileMarket> & { index: number }): ReconcileMarket {
  return breachWish({
    name: 'PT-sUSDS/USDS',
    primary: true,
    totalSupplyAssets: parseEther('2415000'),
    totalBorrowAssets: parseEther('2198000'),
    anchorApy: 0.0293,
    ...overrides,
  });
}

describe('priority withdrawals (cap breaches) under the 15% floor', () => {
  it('serves the priority withdrawal before the band tier when the budget covers only it', () => {
    // Budget 200k (5.45M sleeve, floor 5.25M): the 200k breach takes it all; the
    // 9500-tier wish waits.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('200000') }),
      wish({ index: 1, delta: -parseEther('300000'), bandUtilBps: 9500 }),
    ], parseEther('5450000'));

    expect(legs[0].delta).toBe(-parseEther('200000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].delta).toBe(0n);
    expect(legs[1].note).toMatch(/sleeve floor/);
  });

  it('serves the PRIMARY market\'s priority withdrawal before a larger one when the budget covers only one', () => {
    // Budget 200k (5.45M sleeve, floor 5.25M). The 400k cbBTC breach is listed first
    // and is twice the size, but the PRIMARY market's 200k breach is paid first and
    // takes the whole budget; cbBTC waits.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('400000') }),
      primaryBreachWish({ index: 1, delta: -parseEther('200000') }),
    ], parseEther('5450000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/priority, served first/);
    expect(legs[1].delta).toBe(-parseEther('200000'));
    expect(legs[1].note).toBeUndefined();
  });

  it('serves the largest non-PRIMARY priority withdrawal first, regardless of market order', () => {
    // Budget 300k (5.55M sleeve, floor 5.25M). The 200k cbBTC breach is listed first,
    // but the larger 400k wstETH breach is paid first and takes the whole budget;
    // cbBTC waits.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('200000') }),
      breachWish({ index: 1, name: 'wstETH/USDS', delta: -parseEther('400000') }),
    ], parseEther('5550000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/priority, served first/);
    expect(legs[1].delta).toBe(-parseEther('300000'));
    expect(legs[1].note).toMatch(/priority, served first/);
  });

  it('pays the PRIMARY breach, then the other breaches largest first, then the band tiers', () => {
    // Budget 700k (5.95M sleeve, floor 5.25M). PRIMARY's 200k breach (listed last)
    // comes off the top; wstETH's 200k and cbBTC's 150k breaches follow, largest
    // first; the 150k left lands on the 9500 tier, and the 9200 tier waits.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('150000') }),
      breachWish({ index: 1, name: 'wstETH/USDS', delta: -parseEther('200000') }),
      primaryBreachWish({ index: 2, delta: -parseEther('200000') }),
      wish({ index: 3, delta: -parseEther('300000'), bandUtilBps: 9500 }),
      wish({ index: 4, delta: -parseEther('400000'), bandUtilBps: 9200 }),
    ], parseEther('5950000'));

    expect(legs[0].delta).toBe(-parseEther('150000'));
    expect(legs[1].delta).toBe(-parseEther('200000'));
    expect(legs[2].delta).toBe(-parseEther('200000'));
    expect(legs[3].delta).toBe(-parseEther('150000'));
    expect(legs[3].note).toMatch(/sleeve floor/);
    expect(legs[4].delta).toBe(0n);
    expect(legs[4].note).toMatch(/sleeve floor/);
  });

  it('never drains a priority wish past its own size', () => {
    // Budget 500k (5.75M sleeve, floor 5.25M) exceeds the 200k breach: the drain is
    // exactly the wish, and the 9500 tier takes the 300k left over.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('200000') }),
      wish({ index: 1, delta: -parseEther('600000'), bandUtilBps: 9500 }),
    ], parseEther('5750000'));

    expect(legs[0].delta).toBe(-parseEther('200000'));
    expect(legs[0].note).toBeUndefined();
    expect(legs[1].delta).toBe(-parseEther('300000'));
  });

  it('hands the remainder after the priority withdrawal to the band tiers, 95 before 92', () => {
    // Budget 650k (5.9M sleeve, floor 5.25M): 200k breach first, then tier 95 (300k)
    // whole, then tier 92 gets the last 150k.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('200000') }),
      wish({ index: 1, delta: -parseEther('300000'), bandUtilBps: 9500 }),
      wish({ index: 2, delta: -parseEther('400000'), bandUtilBps: 9200 }),
    ], parseEther('5900000'));

    expect(legs[0].delta).toBe(-parseEther('200000'));
    expect(legs[1].delta).toBe(-parseEther('300000'));
    expect(legs[1].note).toBeUndefined();
    expect(legs[2].delta).toBe(-parseEther('150000'));
    expect(legs[2].note).toMatch(/sleeve floor/);
  });

  it('still refuses a non-priority withdrawal that carries no band', () => {
    // An ordinary drain with no tier key cannot be placed in the floor cut.
    expect(() => reconcile([
      wish({ index: 0, delta: -parseEther('400000'), bandUtilBps: undefined }),
    ], parseEther('5300000'))).toThrow(/withdrawal wish without a band/);
  });

  it('accepts a priority withdrawal without a band', () => {
    // Budget 200k (5.45M sleeve, floor 5.25M): a priority withdrawal has no band by
    // design and is served off the top regardless.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('400000') }),
    ], parseEther('5450000'));

    expect(legs[0].delta).toBe(-parseEther('200000'));
    expect(legs[0].note).toMatch(/priority, served first/);
  });
});

describe('per-leg drop threshold (minActionUsds override)', () => {
  it('keeps a 60k breach leg under a 50k market threshold that the global 100k would drop', () => {
    // Sleeve 6M, inside the limits: the only gate is the drop threshold.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('60000') }),
    ], parseEther('6000000'));

    expect(legs[0].delta).toBe(-parseEther('60000'));
    expect(legs[0].note).toBeUndefined();
  });

  it('keeps a leg landing exactly on its own 50k threshold', () => {
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('50000') }),
    ], parseEther('6000000'));

    expect(legs[0].delta).toBe(-parseEther('50000'));
    expect(legs[0].note).toBeUndefined();
  });

  it('keeps a 1-wei leg when the market threshold is 0 (zero-cap drain to dust)', () => {
    const legs = reconcile([
      breachWish({ index: 0, delta: -1n, minActionUsds: 0n }),
    ], parseEther('6000000'));

    expect(legs[0].delta).toBe(-1n);
    expect(legs[0].note).toBeUndefined();
  });

  it('falls back to the global 100k threshold when the market sets none', () => {
    const legs = reconcile([
      wish({ index: 0, delta: -parseEther('60000'), minActionUsds: undefined }),
    ], parseEther('6000000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/min action 100000 USDS/);
  });

  it('drops a priority leg the floor cuts below its own 50k threshold', () => {
    // Budget 40k (5.29M sleeve, floor 5.25M): the 200k breach is cut to 40k, under
    // the market's 50k threshold — nothing executes this cycle.
    const legs = reconcile([
      breachWish({ index: 0, delta: -parseEther('200000') }),
    ], parseEther('5290000'));

    expect(legs[0].delta).toBe(0n);
    expect(legs[0].note).toMatch(/min action 50000 USDS/);
  });
});
