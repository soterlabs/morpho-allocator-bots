/**
 * Pure optimization logic for the Flagship Vault allocation optimizer.
 *
 * No RPC. Morpho rate math is delegated to @morpho-org/blue-sdk behind the
 * RateModel interface so tests can substitute an analytic mock and the SDK
 * dependency surface stays in this one module.
 */
import { Market, MarketParams } from '@morpho-org/blue-sdk';
import type { Address } from 'viem';
import { capDeallocationsToLiquidity, computeAllocationBudget, capAllocationsToBudget, computeCapLimit, CAP_HEADROOM_BPS, type MarketLiquidity, type AllocationAction } from './allocation-logic.js';

const WAD = 1_000_000_000_000_000_000n;

export interface OptimizerMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface OptimizerMarketState {
  name: string;
  params: OptimizerMarketParams;
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
  rateAtTarget: bigint;
  // The vault's CURRENT supply in this market. rates() rebuilds the market as
  // if the vault's position were a different amount, so the optimizer can
  // evaluate candidate allocations from a common zero baseline.
  vaultAssets: bigint;
  // Max assets the vault may hold here: on-chain relativeCap limit with
  // CAP_HEADROOM_BPS headroom, in asset units. Env targets are NOT bounds.
  effectiveCap: bigint;
}

export interface MarketRates {
  supplyRateWad: bigint; // per-second supply rate, WAD-scaled
  supplyApy: number;     // instantaneous supply APY (0.05 = 5%)
  utilizationWad: bigint;
}

export interface RateModel {
  rates(m: OptimizerMarketState, vaultAlloc: bigint, timestampSec: bigint): MarketRates;
}

function toSdkMarket(m: OptimizerMarketState, timestampSec: bigint): Market {
  const market = new Market({
    params: new MarketParams(m.params),
    totalSupplyAssets: m.totalSupplyAssets,
    totalSupplyShares: m.totalSupplyShares,
    totalBorrowAssets: m.totalBorrowAssets,
    totalBorrowShares: m.totalBorrowShares,
    lastUpdate: m.lastUpdate,
    fee: m.fee,
    rateAtTarget: m.rateAtTarget,
  });
  return market.accrueInterest(timestampSec);
}

/**
 * The market as it would look with the vault's position set to `vaultAlloc`
 * instead of the current `vaultAssets`. Removal is done by direct accounting
 * rather than Market.withdraw() because the hypothetical zero-allocation
 * baseline may transiently exceed available liquidity, which withdraw()
 * rejects; the greedy loop only ever queries rates on such states, it never
 * executes them.
 */
function withVaultAllocation(m: OptimizerMarketState, vaultAlloc: bigint, timestampSec: bigint): Market {
  const accrued = toSdkMarket(m, timestampSec);
  const delta = vaultAlloc - m.vaultAssets;
  if (delta === 0n) return accrued;
  if (delta > 0n) return accrued.supply(delta, 0n, timestampSec).market;
  const assets = -delta;
  const shares = accrued.toSupplyShares(assets, 'Up');
  accrued.totalSupplyAssets -= assets;
  accrued.totalSupplyShares -= shares;
  return accrued;
}

export const sdkRateModel: RateModel = {
  rates(m, vaultAlloc, timestampSec) {
    const market = withVaultAllocation(m, vaultAlloc, timestampSec);
    return {
      supplyRateWad: market.getAvgSupplyRate(timestampSec),
      supplyApy: market.getSupplyApy(timestampSec),
      utilizationWad: market.utilization,
    };
  },
};

/** Morpho AdaptiveCurve IRM target utilization (90%), used as the scoring ceiling. */
export const TARGET_UTILIZATION_WAD = 900_000_000_000_000_000n;

/**
 * Scoring decorator: a state whose utilization exceeds `ceilingWad` is scored as if
 * it earned only the ceiling-state rate (re-evaluated at the smallest allocation
 * that brings utilization down to the ceiling). Above-target utilization is not
 * sustainable - rates adapt upward and borrowers repay or get liquidated - so the
 * optimizer must not chase it. Without this, a vault that dominates a pool's supply
 * side is scored as a monopolist and told to starve the pool for astronomic
 * instantaneous rates. Real utilization is passed through so callers can still see
 * the true state; ONLY use this decorator for scoring, never for display APYs.
 *
 * The ceiling allocation is derived from the raw (unaccrued) supply/borrow fields;
 * accrual moves both sides together, so the residual error is negligible for
 * scoring purposes.
 */
export function withUtilizationCeiling(model: RateModel, ceilingWad: bigint = TARGET_UTILIZATION_WAD): RateModel {
  return {
    rates(m, vaultAlloc, timestampSec) {
      const real = model.rates(m, vaultAlloc, timestampSec);
      if (real.utilizationWad <= ceilingWad) return real;
      const baseSupply = m.totalSupplyAssets - m.vaultAssets;
      let allocAtCeiling = (m.totalBorrowAssets * WAD) / ceilingWad - baseSupply;
      if (allocAtCeiling < vaultAlloc) allocAtCeiling = vaultAlloc; // safety clamp
      const capped = model.rates(m, allocAtCeiling, timestampSec);
      return { supplyRateWad: capped.supplyRateWad, supplyApy: capped.supplyApy, utilizationWad: real.utilizationWad };
    },
  };
}

export interface OptimizeInput {
  totalAssets: bigint;
  // The allocatable budget: min(target allocated amount, aggregate adapter cap
  // headroom). The greedy never exceeds it, so the aggregate cap holds by
  // construction.
  budget: bigint;
  markets: OptimizerMarketState[];
  blockTimestamp: bigint;
  chunkCount?: number; // default 200 (0.1% of totalAssets when budget is 20%)
  // Per-market lower bounds: funds that cannot leave the market this cycle
  // (current position minus the liquidity-capped withdrawable amount).
  // Omitted means all zeros (previous behavior).
  minAllocations?: bigint[];
}

export interface OptimizeResult {
  allocations: bigint[];
  usedBudget: bigint;
  idleBudget: bigint;
  // Amount by which the mandatory floors exceed the budget (adapter stuck over
  // its aggregate cap after all liquidity-possible deallocations); 0n otherwise.
  overBudget: bigint;
}

/**
 * Greedy marginal allocation: repeatedly give one chunk of budget to the
 * market where it adds the most yield. yield(x) = x * supplyRate(x) counts the
 * rate depression a new deposit inflicts on the funds already placed there, so
 * the greedy equalizes MARGINAL yield across markets - the optimality
 * condition - and is exact up to chunk granularity because each market's
 * supply rate is decreasing in allocated amount.
 */
export function optimizeAllocations(input: OptimizeInput, model: RateModel): OptimizeResult {
  const { budget, markets, blockTimestamp } = input;
  const floors = input.minAllocations ?? markets.map(() => 0n);
  if (floors.length !== markets.length) {
    throw new Error(`minAllocations length (${floors.length}) must match markets length (${markets.length})`);
  }
  const allocations = [...floors];
  const sumFloors = floors.reduce((s, f) => s + f, 0n);
  if (budget <= 0n || markets.length === 0) {
    return { allocations, usedBudget: sumFloors, idleBudget: budget > 0n ? budget : 0n, overBudget: sumFloors > budget && budget > 0n ? sumFloors - budget : sumFloors > 0n && budget <= 0n ? sumFloors : 0n };
  }
  if (sumFloors >= budget) {
    // Floors alone meet or exceed the budget: nothing to distribute. The floors are
    // physical reality (stuck funds), so they stand even over the budget.
    return { allocations, usedBudget: sumFloors, idleBudget: 0n, overBudget: sumFloors - budget };
  }
  const chunkCount = BigInt(input.chunkCount ?? 200);
  const baseChunk = budget / chunkCount > 0n ? budget / chunkCount : 1n;

  const yieldAt = (i: number, alloc: bigint): bigint =>
    alloc === 0n ? 0n : alloc * model.rates(markets[i], alloc, blockTimestamp).supplyRateWad;

  let remaining = budget - sumFloors;
  while (remaining > 0n) {
    let bestIndex = -1;
    let bestStep = 0n;
    let bestGainPerUnit = 0n;
    for (let i = 0; i < markets.length; i++) {
      const headroom = markets[i].effectiveCap - allocations[i];
      if (headroom <= 0n) continue;
      let step = baseChunk;
      if (step > headroom) step = headroom;
      if (step > remaining) step = remaining;
      const gain = yieldAt(i, allocations[i] + step) - yieldAt(i, allocations[i]);
      if (gain <= 0n) continue;
      // Normalize per allocated unit so cap-clamped smaller steps compete fairly.
      const gainPerUnit = (gain * WAD) / step;
      if (gainPerUnit > bestGainPerUnit) {
        bestGainPerUnit = gainPerUnit;
        bestIndex = i;
        bestStep = step;
      }
    }
    if (bestIndex === -1) break; // every market capped or zero marginal yield
    allocations[bestIndex] += bestStep;
    remaining -= bestStep;
  }

  const usedBudget = allocations.reduce((s, a) => s + a, 0n);
  return { allocations, usedBudget, idleBudget: budget - usedBudget, overBudget: 0n };
}

/**
 * Quantize an allocation vector to whole basis points of totalAssets. Each
 * market is floored, then the drift versus the floored TOTAL is added to the
 * largest allocation, so the bps sum always equals the used budget in bps.
 */
export function quantizeAllocationsToBps(allocations: bigint[], totalAssets: bigint): number[] {
  if (totalAssets <= 0n) return allocations.map(() => 0);
  const bps = allocations.map(a => Number((a * 10000n) / totalAssets));
  const used = allocations.reduce((s, a) => s + a, 0n);
  const usedBps = Number((used * 10000n) / totalAssets);
  const drift = usedBps - bps.reduce((s, b) => s + b, 0);
  if (drift > 0) {
    let largest = 0;
    for (let i = 1; i < allocations.length; i++) {
      if (allocations[i] > allocations[largest]) largest = i;
    }
    bps[largest] += drift;
  }
  return bps;
}

export interface ProposalInput {
  current: bigint[];
  optimal: bigint[];
  // Pool state per market index (same order as current/optimal, all markets).
  liquidity: MarketLiquidity[];
  minAmount: bigint;     // dust floor for proposed actions
  adapterCap: bigint;    // aggregate adapter cap with headroom, in assets
  adapterAssets: bigint; // adapter's current total assets
}

export interface RebalanceProposal {
  // Actions to reach the optimum exactly, ignoring liquidity.
  target: AllocationAction[];
  // Executable now: deallocations capped to pool liquidity (with the reserve
  // cushion), allocations capped to the aggregate adapter budget freed by the
  // feasible deallocations. Deallocations listed first (execution order).
  feasible: AllocationAction[];
  liquidityLimited: boolean;
}

export function buildRebalanceProposal(input: ProposalInput): RebalanceProposal {
  const { current, optimal, liquidity, minAmount, adapterCap, adapterAssets } = input;
  if (optimal.length !== current.length) {
    throw new Error(`optimal length (${optimal.length}) must match current length (${current.length})`);
  }

  const target: AllocationAction[] = [];
  for (let i = 0; i < current.length; i++) {
    const diff = optimal[i] - current[i];
    if (diff >= minAmount) target.push({ marketIndex: i, action: 'allocate', amount: diff });
    else if (-diff >= minAmount) target.push({ marketIndex: i, action: 'deallocate', amount: -diff });
  }

  const deallocs = target.filter(a => a.action === 'deallocate');
  const capped = capDeallocationsToLiquidity(deallocs, liquidity);
  const feasibleDeallocs: AllocationAction[] = capped
    .filter(c => !c.skipped && c.amount > 0n)
    .map(c => ({ marketIndex: c.marketIndex, action: 'deallocate' as const, amount: c.amount }));
  const totalDeallocated = feasibleDeallocs.reduce((s, a) => s + a.amount, 0n);

  const wantedAllocs = target
    .filter(a => a.action === 'allocate')
    .map(a => ({ marketIndex: a.marketIndex, amount: a.amount }));
  const budget = computeAllocationBudget(adapterCap, adapterAssets, totalDeallocated);
  const budgeted = capAllocationsToBudget(wantedAllocs, budget, minAmount);

  const feasible: AllocationAction[] = [
    ...feasibleDeallocs,
    ...budgeted.map(a => ({ marketIndex: a.marketIndex, action: 'allocate' as const, amount: a.amount })),
  ];

  const wantedAllocTotal = wantedAllocs.reduce((s, a) => s + a.amount, 0n);
  const budgetedTotal = budgeted.reduce((s, a) => s + a.amount, 0n);
  const liquidityLimited = capped.some(c => c.skipped || c.capped) || budgetedTotal < wantedAllocTotal;

  return { target, feasible, liquidityLimited };
}

/**
 * Vault-level supply APY for a given allocation vector, weighted over
 * totalAssets with idle counted at zero yield. Number conversion of wei
 * amounts is lossy above 2^53 wei but the RATIO of two such Numbers keeps
 * ~15 significant digits, which is far beyond reporting precision.
 */
export function computeVaultApy(
  markets: OptimizerMarketState[],
  allocations: bigint[],
  totalAssets: bigint,
  timestampSec: bigint,
  model: RateModel,
): number {
  if (totalAssets <= 0n) return 0;
  let acc = 0;
  for (let i = 0; i < markets.length; i++) {
    if (allocations[i] === 0n) continue;
    const { supplyApy } = model.rates(markets[i], allocations[i], timestampSec);
    acc += (supplyApy * Number(allocations[i])) / Number(totalAssets);
  }
  return acc;
}

/**
 * Effective optimizer bound for one market: the on-chain relative-cap limit with
 * CAP_HEADROOM_BPS headroom, further clamped by the market's off-chain absolute
 * cap when one is configured (e.g. PT-sUSDS's 5M USDS).
 */
export function computeEffectiveMarketCap(totalAssets: bigint, relativeCapWad: bigint, absoluteCap?: bigint): bigint {
  const capLimit = computeCapLimit(totalAssets, relativeCapWad);
  const withHeadroom = capLimit - (capLimit * CAP_HEADROOM_BPS) / 10000n;
  return absoluteCap !== undefined && absoluteCap < withHeadroom ? absoluteCap : withHeadroom;
}

/**
 * Per-market lower bounds for this cycle: the part of the vault's position that
 * cannot be withdrawn right now. Derived by running a hypothetical full-position
 * deallocation through capDeallocationsToLiquidity, so the semantics (flat
 * LIQUIDITY_RESERVE_PERCENT cushion, or the maxUtilizationBps rule where set)
 * are exactly the allocator's. Requires liquidity[i].marketIndex === i.
 */
export function computeReachableFloors(vaultAssets: bigint[], liquidity: MarketLiquidity[]): bigint[] {
  const fullWithdrawals: AllocationAction[] = vaultAssets.map((amount, i) => ({ marketIndex: i, action: 'deallocate' as const, amount }));
  const capped = capDeallocationsToLiquidity(fullWithdrawals, liquidity);
  return vaultAssets.map((amount, i) => {
    const withdrawable = capped[i].skipped ? 0n : capped[i].amount;
    return amount - withdrawable;
  });
}
