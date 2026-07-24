/**
 * Pure allocation logic for the Flagship Vault Allocator Bot.
 *
 * Extracted from allocator.ts so it can be unit-tested without RPC or Safe dependencies.
 */

const WAD = 1_000_000_000_000_000_000n; // 1e18

/**
 * Headroom subtracted from the cap limit before allocating.
 * Covers interest accrual between the fresh RPC read and tx execution.
 * 1 bps (0.01%) of cap limit — covers ~10 min delay at 200% APR max rate.
 */
export const CAP_HEADROOM_BPS = 1n;

/**
 * Percentage of pool supply reserved as a liquidity cushion when deallocating.
 * Prevents the bot from pushing market utilization too high.
 * Default 5% means we leave at least 5% of the pool's totalSupply as idle liquidity.
 * Override via env var LIQUIDITY_RESERVE_PERCENT (integer, e.g. "0" to disable cushion).
 */
export const LIQUIDITY_RESERVE_PERCENT = BigInt(process.env.LIQUIDITY_RESERVE_PERCENT ?? '5');

export interface AllocationAction {
  marketIndex: number;
  action: 'allocate' | 'deallocate';
  amount: bigint;
}

export interface AllocationInput {
  totalAssets: bigint;
  perMarketAssets: bigint[];
  // Per-market target in basis points, one entry per perMarketAssets[] entry.
  // E.g. [500, 500, 500, 500] for the legacy 5% per market across 4 markets,
  // or [0, 1000, 1000, 0] for the deallocation migration scheme.
  // Sum should match the overall allocated target (config.targetAllocatedPercent).
  targetPerMarketBpsByIndex: number[];
  rebalanceThresholdBps: number; // basis points, e.g. 100 = 1%
  // Absolute floor (in asset units) for sweeping retired markets. A market whose target
  // is 0 but which still holds at least this much forces a rebalance even when its bps
  // deviation is below rebalanceThresholdBps — otherwise a retired market's residual
  // could sit just under the threshold (e.g. ~0.1% of totalAssets) and never be swept to
  // the vault. Defaults to 0n (disabled) when omitted. Set this to the bot's dust floor
  // (minAllocationAmount) so retired markets drain down to genuine dust, not to ~0.1%.
  minSweepAmount?: bigint;
}

export interface AllocationResult {
  actions: AllocationAction[];
  skipped: boolean;
  reason?: string;
}

/**
 * Replicate the vault's `mulDivDown(totalAssets, relativeCap, WAD)` exactly.
 * Returns the maximum allocation allowed by a relative cap for a given totalAssets.
 *
 * @param totalAssets - The vault's totalAssets (matches firstTotalAssets in the same block)
 * @param relativeCapWad - The relative cap in WAD (e.g. 5e16 for 5%)
 */
export function computeCapLimit(totalAssets: bigint, relativeCapWad: bigint): bigint {
  return totalAssets * relativeCapWad / WAD;
}

/**
 * Convert a basis-points cap value to WAD for use with computeCapLimit.
 * E.g. 500 bps (5%) → 5e16
 */
export function bpsToWad(bps: number): bigint {
  return BigInt(bps) * WAD / 10000n;
}

/**
 * Parse a per-market target (basis points) from a raw env value.
 *
 * Returns `defaultBps` ONLY when the value is unset (undefined). Any value that is
 * present but not a plain whole number in [0, 10000] throws — this deliberately
 * rejects the silent footguns of `Number(...)`: empty/whitespace strings (which
 * `Number` coerces to 0), negatives, decimals, and non-decimal forms like "0x10"
 * or "1e3". The `/^\d+$/` test runs before `Number()` so only canonical bps pass.
 */
export function parseTargetBps(raw: string | undefined, defaultBps: number, label: string): number {
  if (raw === undefined) return defaultBps;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number of basis points in [0, 10000], got "${raw}"`);
  }
  const value = Number(trimmed);
  if (value > 10000) {
    throw new Error(`${label} must be <= 10000 basis points, got "${raw}"`);
  }
  return value;
}

/**
 * Validate that per-market targets sum to the expected total-allocated target.
 * Throws a descriptive error listing every market on mismatch. Validate over the
 * FULL market set (not just the oracle-configured subset) so that partial
 * deployments — where some markets have no oracle yet — don't false-positive:
 * every market always carries a target (defaulted), so the sum is well-defined.
 */
export function validateTargetBpsSum(targets: { label: string; bps: number }[], expectedSum: number): void {
  const sum = targets.reduce((acc, t) => acc + t.bps, 0);
  if (sum !== expectedSum) {
    throw new Error(
      `Sum of per-market targetBps (${sum}) must equal targetAllocatedPercent (${expectedSum}). ` +
      `Targets: ${targets.map(t => `${t.label}=${t.bps}`).join(', ')}`
    );
  }
}

/**
 * Compute the allocation/deallocation actions needed to reach target per-market allocations.
 *
 * For allocations, the returned amounts are approximate (based on the initial state read).
 * The caller should re-read fresh state before each allocation and recompute the exact
 * amount using computeCapLimit() to avoid RelativeCapExceeded from interest accrual.
 *
 * Cases handled:
 * 1. Within threshold  — no actions (deviation < rebalanceThresholdBps)
 * 2. Under-allocated   — allocate the deficit per market
 * 3. Over-allocated    — deallocate the excess per market
 * 4. Mixed             — some markets get allocations, others get deallocations
 * 5. Partial (bug fix) — only under-funded markets receive allocations;
 *                         markets already at target are skipped
 * 6. Dust sweep        — a retired (target-0) market still holding >= minSweepAmount
 *                         forces a rebalance even when below the bps threshold, so its
 *                         residual is deallocated back to the vault rather than stranded
 */
export function computeAllocationActions(input: AllocationInput): AllocationResult {
  const {
    totalAssets,
    perMarketAssets,
    targetPerMarketBpsByIndex,
    rebalanceThresholdBps,
    minSweepAmount = 0n,
  } = input;

  if (targetPerMarketBpsByIndex.length !== perMarketAssets.length) {
    throw new Error(
      `targetPerMarketBpsByIndex length (${targetPerMarketBpsByIndex.length}) must match perMarketAssets length (${perMarketAssets.length})`
    );
  }

  if (totalAssets === 0n) {
    return { actions: [], skipped: true, reason: 'totalAssets is zero' };
  }

  // Compute per-market actions and track the worst per-market deviation. We short-circuit
  // on the maximum per-market deviation (not the aggregate): with asymmetric targets the
  // aggregate can match exactly while individual markets are far off target.
  const actions: AllocationAction[] = [];
  let maxDeviationBps = 0;
  // A retired (target-0) market still holding >= minSweepAmount must be drained even if
  // its deviation is below the bps threshold, so its residual isn't stranded in-market.
  let sweepNeeded = false;

  for (let i = 0; i < perMarketAssets.length; i++) {
    const current = perMarketAssets[i];
    const targetBps = targetPerMarketBpsByIndex[i];
    const targetPerMarket = (totalAssets * BigInt(targetBps)) / 10000n;

    const diff = current > targetPerMarket ? current - targetPerMarket : targetPerMarket - current;
    const devBps = Number((diff * 10000n) / totalAssets);
    if (devBps > maxDeviationBps) maxDeviationBps = devBps;

    if (minSweepAmount > 0n && targetBps === 0 && current >= minSweepAmount) {
      sweepNeeded = true;
    }

    if (current < targetPerMarket) {
      const deficit = targetPerMarket - current;
      if (deficit > 0n) {
        actions.push({ marketIndex: i, action: 'allocate', amount: deficit });
      }
    } else if (current > targetPerMarket) {
      const excess = current - targetPerMarket;
      if (excess > 0n) {
        actions.push({ marketIndex: i, action: 'deallocate', amount: excess });
      }
    }
  }

  // Short-circuit on max per-market deviation, UNLESS a retired market needs sweeping.
  if (maxDeviationBps < rebalanceThresholdBps && !sweepNeeded) {
    return { actions: [], skipped: true, reason: 'within threshold' };
  }

  if (actions.length === 0) {
    return { actions: [], skipped: true, reason: 'all markets at target' };
  }

  return { actions, skipped: false };
}

/**
 * Whether a deallocation should execute under the dust filter.
 *
 * Drain-to-zero markets (targetBps === 0) ALWAYS execute, so a retiring market fully
 * empties rather than stranding a sub-floor residual forever (the migration's whole
 * point). For other markets, a negligible trim (desired excess below the floor) is
 * suppressed. The decision is made on the DESIRED (pre-liquidity-cap) excess so that a
 * liquidity-limited large drain still makes incremental progress every run instead of
 * being dropped because this run's withdrawable slice happens to be small.
 */
export function shouldExecuteDeallocate(desiredAmount: bigint, targetBps: number, minAmount: bigint): boolean {
  if (targetBps === 0) return true;
  return desiredAmount >= minAmount;
}

// ---------------------------------------------------------------------------
// Build-loop composition (pure). These turn raw per-market state into ordered,
// explicit outcomes so the executor (allocator.ts main) is a thin map from
// outcome -> log + on-chain call, and the fund-affecting decisions are unit-tested.
// ---------------------------------------------------------------------------

export interface DeallocatePlanItem {
  marketIndex: number;
  targetBps: number;
  desired: bigint;            // pre-liquidity-cap excess over target
  cappedAmount: bigint;       // amount after liquidity capping
  capped: boolean;            // true if cappedAmount < desired due to liquidity
  skipped: boolean;           // true if no withdrawable liquidity at all
  availableLiquidity: bigint;
}

export type DeallocateOutcome =
  | { marketIndex: number; status: 'skip-liquidity'; availableLiquidity: bigint }
  | { marketIndex: number; status: 'skip-dust'; desired: bigint }
  | { marketIndex: number; status: 'execute'; amount: bigint; capped: boolean; availableLiquidity: bigint };

/**
 * Plan deallocations: apply the liquidity-skip, then the dust filter (which exempts
 * drain-to-zero markets and judges on the pre-cap desired amount), preserving input order.
 * NOTE: the dust decision uses `desired` (pre-cap), NOT `cappedAmount`, so a liquidity-
 * limited large drain still makes incremental progress.
 */
export function planDeallocations(items: DeallocatePlanItem[], minAmount: bigint): DeallocateOutcome[] {
  return items.map((it): DeallocateOutcome => {
    if (it.skipped) {
      return { marketIndex: it.marketIndex, status: 'skip-liquidity', availableLiquidity: it.availableLiquidity };
    }
    if (!shouldExecuteDeallocate(it.desired, it.targetBps, minAmount)) {
      return { marketIndex: it.marketIndex, status: 'skip-dust', desired: it.desired };
    }
    return { marketIndex: it.marketIndex, status: 'execute', amount: it.cappedAmount, capped: it.capped, availableLiquidity: it.availableLiquidity };
  });
}

export interface AllocatePlanItem {
  marketIndex: number;
  effectiveCap: bigint;
  freshExpected: bigint;
}

export type AllocateOutcome =
  | { marketIndex: number; status: 'skip-atcap' }          // already at/over effective cap — routine no-op
  | { marketIndex: number; status: 'skip-dust'; gap: bigint } // 0 < gap < minAmount
  | { marketIndex: number; status: 'execute'; amount: bigint };

/**
 * Plan allocations: each market's executable amount is the gap to its effective cap,
 * subject to the dust floor. Distinguishes "already at cap" (routine, silent) from a
 * "dust gap" (worth a log) so the executor doesn't spam at-cap skip lines every run.
 */
export function planAllocations(items: AllocatePlanItem[], minAmount: bigint): AllocateOutcome[] {
  return items.map(({ marketIndex, effectiveCap, freshExpected }): AllocateOutcome => {
    const gap = effectiveCap > freshExpected ? effectiveCap - freshExpected : 0n;
    if (gap >= minAmount) return { marketIndex, status: 'execute', amount: gap };
    return gap === 0n
      ? { marketIndex, status: 'skip-atcap' }
      : { marketIndex, status: 'skip-dust', gap };
  });
}

/**
 * Constrain a set of planned allocations to a shared budget — the room left under the
 * vault's AGGREGATE adapter cap (e.g. 20%) after this cycle's deallocations.
 *
 * The per-market effective caps only bound each market individually; nothing stops their
 * SUM from pushing the adapter over its aggregate cap, which reverts the whole atomic
 * batch (RelativeCapExceeded). This is especially likely mid-migration: when retiring
 * markets can only be partially drained (liquidity-limited) but the growing markets
 * allocate at full size, the adapter balloons past its cap.
 *
 * If the total fits the budget, allocations pass through unchanged. Otherwise each is
 * scaled down proportionally to its share of the total, and any result below minAmount is
 * dropped as dust. A non-positive budget (adapter already at/over cap) yields no
 * allocations — the bot just deallocates this cycle and grows next cycle as room frees up.
 */
/**
 * Room available for new allocations this cycle under the vault's AGGREGATE adapter cap.
 *
 * Allocations are funded from the vault's idle balance, independent of this cycle's
 * deallocations, so their total must keep the adapter position — `adapterAssets` now, minus
 * what we deallocate this cycle (deallocations execute first in the atomic batch) — under
 * its cap. Returns 0 when the adapter is already at/over cap, i.e. a deallocate-only cycle.
 *
 * Note: this is intentionally conservative. `adapterAssets` should be the live, fully-accrued
 * adapter total (realAssets), which is >= the vault's internally-tracked `allocation[id]`
 * that the cap is actually enforced against, and `adapterCap` is derived from the bot's
 * current totalAssets read which is <= the vault's post-accrual firstTotalAssets — so the
 * real on-chain headroom is always at least this budget.
 */
export function computeAllocationBudget(adapterCap: bigint, adapterAssets: bigint, totalDeallocated: bigint): bigint {
  const adapterAfterDealloc = adapterAssets - totalDeallocated;
  return adapterCap > adapterAfterDealloc ? adapterCap - adapterAfterDealloc : 0n;
}

export function capAllocationsToBudget(
  allocations: { marketIndex: number; amount: bigint }[],
  budget: bigint,
  minAmount: bigint,
): { marketIndex: number; amount: bigint }[] {
  if (budget <= 0n) return [];
  const total = allocations.reduce((sum, a) => sum + a.amount, 0n);
  if (total <= budget) return allocations;
  return allocations
    .map(a => ({ marketIndex: a.marketIndex, amount: (a.amount * budget) / total }))
    .filter(a => a.amount >= minAmount);
}

export interface MarketLiquidity {
  marketIndex: number;
  totalSupplyAssets: bigint;
  totalBorrowAssets: bigint;
}

export interface CappedAction {
  marketIndex: number;
  amount: bigint;
  capped: boolean;       // true if amount was reduced due to liquidity
  skipped: boolean;      // true if skipped entirely (no withdrawable liquidity)
  availableLiquidity: bigint;
}

/**
 * Cap deallocate amounts to available market liquidity, reserving a cushion
 * to avoid pushing utilization to 100%.
 *
 * For each market:
 *   reserve = totalSupplyAssets * LIQUIDITY_RESERVE_PERCENT / 100
 *   maxWithdrawable = max(0, liquidity - reserve)
 *   actualAmount = min(desiredAmount, maxWithdrawable)
 */
export function capDeallocationsToLiquidity(
  actions: AllocationAction[],
  marketLiquidity: MarketLiquidity[],
): CappedAction[] {
  // Index liquidity by marketIndex for O(1) lookup
  const liquidityByIndex = new Map<number, MarketLiquidity>();
  for (const ml of marketLiquidity) {
    liquidityByIndex.set(ml.marketIndex, ml);
  }

  return actions.map(a => {
    const ml = liquidityByIndex.get(a.marketIndex);
    if (!ml) {
      // No liquidity data — skip to be safe (shouldn't happen)
      return { marketIndex: a.marketIndex, amount: 0n, capped: false, skipped: true, availableLiquidity: 0n };
    }

    const liquidity = ml.totalSupplyAssets > ml.totalBorrowAssets
      ? ml.totalSupplyAssets - ml.totalBorrowAssets
      : 0n;

    const reserve = ml.totalSupplyAssets * LIQUIDITY_RESERVE_PERCENT / 100n;
    const maxWithdrawable = liquidity > reserve ? liquidity - reserve : 0n;

    if (maxWithdrawable === 0n) {
      return { marketIndex: a.marketIndex, amount: 0n, capped: false, skipped: true, availableLiquidity: liquidity };
    }

    const actualAmount = a.amount < maxWithdrawable ? a.amount : maxWithdrawable;
    return {
      marketIndex: a.marketIndex,
      amount: actualAmount,
      capped: actualAmount < a.amount,
      skipped: false,
      availableLiquidity: liquidity,
    };
  });
}
