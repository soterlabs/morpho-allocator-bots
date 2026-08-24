/**
 * Pure wiring between the market table, the band controller and reconciliation,
 * shared by the executor (allocator.ts computeBandPlan) and the fork simulator so
 * both derive caps, wish flags and drop thresholds from one definition.
 * All amounts are 18-dec USDS.
 */

import type { BandConfig } from './band-config.js';
import type { BandDecision, MarketObservation } from './band-controller.js';
import { computeMarketCap, type MarketConfig } from './market-config.js';
import { computeEffectiveMarketCap } from './optimizer-logic.js';
import type { ReconcileMarket } from './reconcile.js';

/**
 * The two caps a bands-mode observation carries, on one totalAssets snapshot:
 *   marketCap    — the env cap (computeMarketCap); the breach line. Undefined for a
 *                  market with no env cap.
 *   effectiveCap — the deposit ceiling: marketCap further clamped by the on-chain
 *                  relative cap (with headroom), which the vault enforces on allocate;
 *                  just the on-chain bound when there is no env cap.
 */
export function bandsCaps(
  market: MarketConfig, totalAssets: bigint, relativeCapWad: bigint,
): { marketCap?: bigint; effectiveCap: bigint } {
  const marketCap = computeMarketCap(market, totalAssets);
  return { marketCap, effectiveCap: computeEffectiveMarketCap(totalAssets, relativeCapWad, marketCap) };
}

/**
 * Whether a decision drains a zero-cap market: such a drain must reach the executor
 * even below its dust floor (the market must end up holding nothing).
 */
export function isDrainToZero(decision: BandDecision, observation: MarketObservation): boolean {
  return decision.rule === 'R-PRIORITY-WITHDRAWAL' && observation.marketCap === 0n;
}

/**
 * Drop threshold for a priority withdrawal: minPriorityWithdrawalUsds, except that a
 * zero-cap drain may also pass as the whole wish (the controller already sized it
 * above the dust floor) — a floor cut that leaves only part of it still has to
 * clear the min.
 */
function priorityWithdrawalThreshold(decision: BandDecision, observation: MarketObservation, cfg: BandConfig): bigint {
  const wish = observation.vaultAssets - decision.targetAmount;
  return isDrainToZero(decision, observation) && wish < cfg.minPriorityWithdrawalUsds
    ? wish
    : cfg.minPriorityWithdrawalUsds;
}

/**
 * The reconciliation wish for one market: the decision's delta with its priority
 * flag, whether the market is the PRIMARY one, the band tier of an ordinary
 * withdrawal, and the drop threshold the leg must clear — priorityWithdrawalThreshold
 * for a priority withdrawal, the global min action otherwise.
 */
export function toReconcileMarket(
  market: MarketConfig, observation: MarketObservation, decision: BandDecision, cfg: BandConfig,
): ReconcileMarket {
  return {
    index: observation.index,
    name: market.name,
    delta: decision.targetAmount - observation.vaultAssets,
    priority: decision.priority,
    primary: market.mode === 'PRIMARY',
    bandUtilBps: decision.bandUtilBps,
    minActionUsds: decision.rule === 'R-PRIORITY-WITHDRAWAL'
      ? priorityWithdrawalThreshold(decision, observation, cfg)
      : undefined,
    totalSupplyAssets: observation.totalSupplyAssets,
    totalBorrowAssets: observation.totalBorrowAssets,
    anchorApy: observation.anchorApy,
  };
}
