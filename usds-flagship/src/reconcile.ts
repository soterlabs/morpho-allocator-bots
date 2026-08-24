/**
 * Vault-level reconciliation of per-market steering wishes (spec "krok 4").
 *
 * The band controller produces one wish per market; this module turns the wish list
 * into the final transaction legs by enforcing the vault-level sleeve limits: the
 * allocated sleeve (sum of market positions) must end the batch inside
 * [sleeveFloorBps, sleeveCapBps] of totalAssets. Both limits are hard and are checked
 * on the post-batch state; at most one side can be short of budget. On each side the
 * PRIORITY wishes (the PRIMARY market's deposit, cap-breach withdrawals) are served
 * first, off the top of the budget; the ordinary wishes share what is left:
 *
 *   - deposits exceed the cap  -> the priority deposit is carved out first, then
 *     waterfilling: fill the highest-earning markets down to a common spot supply APY
 *     level, so no dollar of the remaining budget could be moved to a better market.
 *     The deposit budget credits same-batch withdrawals.
 *
 *   - withdrawals break the floor -> priority withdrawals are served first (the
 *     PRIMARY market's ahead of the others, then the largest first), then the band
 *     wishes are cut in tiers from the deepest band down: whole tiers are served
 *     fully; the tier the budget cannot cover lands on one common utilization
 *     u* = pooledBorrow / (pooledSupply - budget), so every market in it heats at
 *     the same tempo; shallower tiers wait. The withdrawal budget credits same-batch
 *     deposits.
 *
 * Legs smaller than their drop threshold (minActionUsds, or the market's own
 * minActionUsds override) are dropped at the end. PURE: no RPC, no env.
 * All amounts are 18-dec USDS; rates are APY fractions (0.0352 = 3.52%).
 */

/** Adaptive Curve IRM shape: borrow rate = anchor x curve(err), steepness 4. */
const CURVE_STEEPNESS = 4;
const TARGET_UTILIZATION = 0.9;

/** Stop bisecting amounts below 0.001 USDS — far under any actionable granularity. */
const AMOUNT_PRECISION_WEI = 10n ** 15n;
const LEVEL_BISECTION_STEPS = 64;

const USDS_WAD = 10n ** 18n;

/** Format an 18-dec amount as whole USDS for notes (display truncation only). */
function fmtUsds(x: bigint): string {
  return `${x / USDS_WAD} USDS`;
}

export interface ReconcileMarket {
  index: number;
  name: string;
  /** Wished vault delta from the band decision: > 0 deposit, < 0 withdrawal, 0 no action. */
  delta: bigint;
  /**
   * Served before the ordinary wishes on its side: a PRIMARY deposit (carved off the
   * budget before waterfilling) or a cap-breach withdrawal (paid before the band tiers).
   */
  priority: boolean;
  /** The PRIMARY market: its priority withdrawal is paid ahead of the other ones. */
  primary: boolean;
  /** Band behind a non-priority withdrawal (tier key for the floor cut). */
  bandUtilBps?: number;
  /** Drop threshold for this market's final leg; defaults to the global minActionUsds. */
  minActionUsds?: bigint;
  totalSupplyAssets: bigint;
  totalBorrowAssets: bigint;
  anchorApy: number;
}

export interface ReconciledLeg {
  index: number;
  /** Final vault delta after the sleeve-limit cuts and the min-action drop. */
  delta: bigint;
  /** Set when reconciliation changed the wish. */
  note?: string;
}

/**
 * Instantaneous supply APY of a pool at the given state (fee 0 on all Flagship
 * markets): borrowApy(util) x util, with the Adaptive Curve IRM multiplier
 * around the 90% target. Computed in APY space — the same linear-in-APY
 * approximation the controller uses for satAPY, plenty for ranking deposits.
 */
function spotSupplyApy(anchorApy: number, totalSupplyAssets: bigint, totalBorrowAssets: bigint): number {
  if (totalSupplyAssets <= 0n) return 0;
  const util = Number(totalBorrowAssets) / Number(totalSupplyAssets);
  const err = util >= TARGET_UTILIZATION
    ? (util - TARGET_UTILIZATION) / (1 - TARGET_UTILIZATION)
    : (util - TARGET_UTILIZATION) / TARGET_UTILIZATION;
  const curve = err >= 0
    ? 1 + (CURVE_STEEPNESS - 1) * err
    : 1 + (1 - 1 / CURVE_STEEPNESS) * err;
  return anchorApy * curve * util;
}

/**
 * Largest deposit d in [0, maxDeposit] that keeps the market's spot supply APY at or
 * above `level` (depositing dilutes the rate, so the APY is decreasing in d).
 */
function depositToSpotLevel(m: ReconcileMarket, level: number, maxDeposit: bigint): bigint {
  if (maxDeposit <= 0n) return 0n;
  if (spotSupplyApy(m.anchorApy, m.totalSupplyAssets + maxDeposit, m.totalBorrowAssets) >= level) {
    return maxDeposit;
  }
  if (spotSupplyApy(m.anchorApy, m.totalSupplyAssets, m.totalBorrowAssets) < level) {
    return 0n;
  }
  let lo = 0n;             // spot(lo) >= level
  let hi = maxDeposit;     // spot(hi) < level
  while (hi - lo > AMOUNT_PRECISION_WEI) {
    const mid = (lo + hi) / 2n;
    if (spotSupplyApy(m.anchorApy, m.totalSupplyAssets + mid, m.totalBorrowAssets) >= level) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Cut deposit wishes to `budget` by waterfilling: find the common spot supply APY
 * level at which the summed fills fit the budget, and fill each market down to it.
 * The level is bisected to the smallest value whose fills still fit, so the result
 * never exceeds the budget. Returns the final deposit per market index.
 */
function waterfillDeposits(deposits: ReconcileMarket[], budget: bigint): Map<number, bigint> {
  const fillsAt = (level: number): Map<number, bigint> =>
    new Map(deposits.map(m => [m.index, depositToSpotLevel(m, level, m.delta)]));
  const totalAt = (fills: Map<number, bigint>): bigint =>
    [...fills.values()].reduce((sum, x) => sum + x, 0n);

  if (deposits.length === 0) return new Map();
  if (budget <= 0n) return new Map(deposits.map(m => [m.index, 0n]));
  const wishTotal = deposits.reduce((sum, m) => sum + m.delta, 0n);
  if (wishTotal <= budget) return new Map(deposits.map(m => [m.index, m.delta]));

  let lo = 0; // fills(lo) > budget
  let hi = Math.max(...deposits.map(m => spotSupplyApy(m.anchorApy, m.totalSupplyAssets, m.totalBorrowAssets)));
  if (hi <= 0) {
    // Every deposit market earns nothing right now — there is no "earns most" to rank
    // by, and depositing into a zero-rate market cannot beat idle. Fill nothing.
    return new Map(deposits.map(m => [m.index, 0n]));
  }
  // At the current best spot rate no market accepts a fill, so fills(hi) = 0 <= budget.
  for (let i = 0; i < LEVEL_BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (totalAt(fillsAt(mid)) > budget) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return fillsAt(hi);
}

/**
 * Cut deposit wishes to `budget`: the priority deposit (the PRIMARY market) is served
 * first, up to the whole budget, and never ranked by its spot rate — it is the
 * vault's declared destination, not a yield pick. The rest of the budget is
 * waterfilled across the ordinary deposits. Returns the final deposit per market
 * index; the sum never exceeds the budget.
 */
function cutDeposits(deposits: ReconcileMarket[], budget: bigint): Map<number, bigint> {
  const priority = deposits.filter(m => m.priority);
  if (priority.length > 1) {
    throw new Error(
      `${priority.map(m => m.name).join(', ')} all carry priority deposits — the carve is defined for one market`
    );
  }
  const result = new Map<number, bigint>();
  let remaining = budget < 0n ? 0n : budget;
  for (const m of priority) {
    const fill = m.delta < remaining ? m.delta : remaining;
    result.set(m.index, fill);
    remaining -= fill;
  }
  for (const [index, fill] of waterfillDeposits(deposits.filter(m => !m.priority), remaining)) {
    result.set(index, fill);
  }
  return result;
}

/** The part of a withdrawal wish (< 0) the remaining budget can pay, as a delta (<= 0). */
function serveUpTo(wish: bigint, remaining: bigint): bigint {
  return -wish < remaining ? wish : -remaining;
}

/**
 * Order among priority withdrawals: the PRIMARY market first (so lowering its cap
 * winds it down ahead of everything else), then the largest wish first — deltas are
 * negative, so ascending delta is descending size.
 */
function primaryThenLargestFirst(a: ReconcileMarket, b: ReconcileMarket): number {
  if (a.primary !== b.primary) return a.primary ? -1 : 1;
  return a.delta < b.delta ? -1 : a.delta > b.delta ? 1 : 0;
}

/**
 * Cut withdrawal wishes to `budget`: priority withdrawals (cap breaches) are served
 * first — the PRIMARY market's ahead of the others, then the largest first — each
 * up to what is left; the band wishes then share the remainder in tiers from the
 * deepest band down. Tiers the budget covers pass whole; the marginal tier is
 * pooled as one market and every member is withdrawn to the common utilization
 * u* = pooledBorrow / (pooledSupply - remainingBudget); tiers below it are dropped.
 * A cut never exceeds the original wish. Returns the final withdrawal (<= 0) per
 * market index.
 */
function cutWithdrawals(withdrawals: ReconcileMarket[], budget: bigint): Map<number, bigint> {
  const result = new Map<number, bigint>(withdrawals.map(m => [m.index, 0n]));
  let remaining = budget < 0n ? 0n : budget;

  for (const m of withdrawals.filter(m => m.priority).sort(primaryThenLargestFirst)) {
    const serve = serveUpTo(m.delta, remaining);
    result.set(m.index, serve);
    remaining += serve;
  }

  const tiers = new Map<number, ReconcileMarket[]>();
  for (const m of withdrawals.filter(m => !m.priority)) {
    if (m.bandUtilBps === undefined) {
      throw new Error(`${m.name}: withdrawal wish without a band — cannot tier it for the floor cut`);
    }
    const tier = tiers.get(m.bandUtilBps) ?? [];
    tier.push(m);
    tiers.set(m.bandUtilBps, tier);
  }

  for (const bandUtilBps of [...tiers.keys()].sort((a, b) => b - a)) {
    const tier = tiers.get(bandUtilBps)!;
    const tierTotal = tier.reduce((sum, m) => sum - m.delta, 0n);
    if (tierTotal <= remaining) {
      for (const m of tier) result.set(m.index, m.delta);
      remaining -= tierTotal;
      continue;
    }
    for (const [index, cut] of cutMarginalTier(tier, remaining)) result.set(index, cut);
    break; // shallower tiers get nothing this cycle
  }
  return result;
}

/**
 * Land the marginal tier on the common utilization the remaining budget allows:
 * every served member ends at u* = pooledBorrow / (pooledSupply - budget), heating at
 * the same tempo. The pooled formula conserves the budget only across members it
 * actually cuts, so each pass re-derives the level over a corrected pool — otherwise
 * an uncuttable member's pool weight pushes the others past the budget and through
 * the hard sleeve floor:
 *
 *   - a member already at/above the common utilization takes no cut and leaves the
 *     pool for this pass,
 *   - a member wished shallower than its formula cut is served at the wish; its size
 *     leaves the budget and the level is recomputed over everyone not yet served.
 *
 * Every pass shrinks the pool or serves a member, so this terminates. Returns the
 * final withdrawal (<= 0) per tier-member index.
 */
function cutMarginalTier(tier: ReconcileMarket[], budget: bigint): Map<number, bigint> {
  const result = new Map<number, bigint>(tier.map(m => [m.index, 0n]));
  const unserved = new Map<number, ReconcileMarket>(tier.map(m => [m.index, m]));
  let pool = [...unserved.values()];
  let remaining = budget;

  while (pool.length > 0 && remaining > 0n) {
    const pooledSupply = pool.reduce((sum, m) => sum + m.totalSupplyAssets, 0n);
    const pooledBorrow = pool.reduce((sum, m) => sum + m.totalBorrowAssets, 0n);
    if (pooledBorrow === 0n) {
      // No borrows in the pool: utilization is 0 whatever we withdraw, so the
      // common-util formula degenerates — serve the wishes in order instead.
      for (const m of pool) {
        const serve = serveUpTo(m.delta, remaining);
        result.set(m.index, serve);
        remaining += serve;
      }
      return result;
    }

    const cuts = pool.map(m => ({
      m,
      cut: (m.totalBorrowAssets * (pooledSupply - remaining)) / pooledBorrow - m.totalSupplyAssets,
    }));
    const cuttable = cuts.filter(c => c.cut < 0n);
    if (cuttable.length < cuts.length) {
      pool = cuttable.map(c => c.m);
      continue;
    }

    const wishBound = cuts.filter(c => c.cut < c.m.delta);
    if (wishBound.length > 0) {
      for (const c of wishBound) {
        result.set(c.m.index, c.m.delta);
        remaining += c.m.delta;
        unserved.delete(c.m.index);
      }
      pool = [...unserved.values()];
      continue;
    }

    for (const c of cuts) result.set(c.m.index, c.cut);
    return result;
  }
  return result;
}

/**
 * Reconcile the wish list against the vault-level sleeve limits and drop legs below
 * their threshold. Returns one leg per input market, in input order; a delta of 0
 * means no transaction for that market this cycle.
 */
export function reconcileToVaultLimits(args: {
  markets: ReconcileMarket[];
  /** Current allocated sleeve: sum of the vault's positions across all markets. */
  sleeveUsds: bigint;
  totalAssets: bigint;
  sleeveFloorBps: number;
  sleeveCapBps: number;
  /** Drop threshold for legs whose market sets no minActionUsds of its own. */
  minActionUsds: bigint;
}): ReconciledLeg[] {
  const { markets, sleeveUsds, totalAssets, sleeveFloorBps, sleeveCapBps, minActionUsds } = args;

  const deposits = markets.filter(m => m.delta > 0n);
  const withdrawals = markets.filter(m => m.delta < 0n);
  const depositTotal = deposits.reduce((sum, m) => sum + m.delta, 0n);
  const withdrawalTotal = withdrawals.reduce((sum, m) => sum - m.delta, 0n);
  const sleeveAfter = sleeveUsds + depositTotal - withdrawalTotal;

  const cap = (totalAssets * BigInt(sleeveCapBps)) / 10000n;
  const floor = (totalAssets * BigInt(sleeveFloorBps)) / 10000n;

  const legs: ReconciledLeg[] = markets.map(m => ({ index: m.index, delta: m.delta }));

  if (sleeveAfter > cap) {
    const fills = cutDeposits(deposits, cap - sleeveUsds + withdrawalTotal);
    markets.forEach((m, i) => {
      if (m.delta <= 0n) return;
      legs[i].delta = fills.get(m.index)!;
      if (legs[i].delta < m.delta) {
        legs[i].note = `deposit cut from ${fmtUsds(m.delta)} by the ${sleeveCapBps} bps sleeve cap` +
          (m.priority ? ' (priority, served first)' : ' (waterfilled)');
      }
    });
  } else if (sleeveAfter < floor) {
    const cuts = cutWithdrawals(withdrawals, sleeveUsds - floor + depositTotal);
    markets.forEach((m, i) => {
      if (m.delta >= 0n) return;
      legs[i].delta = cuts.get(m.index)!;
      if (legs[i].delta > m.delta) {
        legs[i].note = `withdrawal cut from ${fmtUsds(-m.delta)} by the ${sleeveFloorBps} bps sleeve floor` +
          (m.priority ? ' (priority, served first)' : '');
      }
    });
  }

  markets.forEach((m, i) => {
    const leg = legs[i];
    const threshold = m.minActionUsds ?? minActionUsds;
    const size = leg.delta < 0n ? -leg.delta : leg.delta;
    if (size > 0n && size < threshold) {
      leg.delta = 0n;
      leg.note = `leg ${fmtUsds(size)} below min action ${fmtUsds(threshold)} — dropped`;
    }
  });
  return legs;
}
