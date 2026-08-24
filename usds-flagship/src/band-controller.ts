/**
 * Pure per-market decision engine for the Flagship Vault Allocator Bot (bands mode).
 *
 * Turns per-market observations + BandConfig + the on-chain SSR into one BandDecision
 * per market. PURE by design: no RPC, no env reads — the entire fund-affecting decision
 * surface is unit-testable, and the executor is a thin map from BandDecision ->
 * on-chain allocate/deallocate.
 *
 * Every market emits at most ONE wish per cycle, chosen in this order:
 *
 *   0. Priority withdrawal (STEERED and PRIMARY with an env cap): a position above
 *      the market's cap by at least minPriorityWithdrawalUsds (by at least the dust
 *      floor when the cap is 0) is drained back to the cap — no band, no deadband, no
 *      cooldown, no share gate; only the pool's withdrawable liquidity and
 *      MAX_DEALLOCATE bound it. It replaces whatever steering would have wished.
 *   1. Priority deposit (PRIMARY): no band — the wish is always "fill to
 *      effectiveCap", served by reconciliation before any other deposit. A PRIMARY
 *      market withdraws only through rule 0.
 *   2. Steering (STEERED): satAPY = 0.9 x anchorAPY picks the utilization band from
 *      thresholds derived from SSR_t = SSR + margin (see pickBand); inside the
 *      SSR_t +- tolerance zone the market HOLDs. The band is inverted into an absolute
 *      vault target (targetSupply = ceil(borrow / band)).
 *
 * Rules 1 and 2 size their wish through the same three steps, called in order:
 * boundTarget (the deposit ceiling), sizeGate (min action, direction cooldown),
 * clampToStepCaps. Steering adds the utilization deadband before and the monopolist
 * share after the shared gate.
 *
 * RETIRED markets are never touched — not even above their cap. SOUNDING is rejected
 * at startup (market-config.ts parseMarketMode) and defensively rejected here too.
 *
 * Vault-level reconciliation of the resulting wish list against the sleeve limits
 * (spec "krok 4") lives in reconcile.ts.
 *
 * All timestamps are UTC unix seconds. All amounts are 18-dec USDS.
 */

import type { BandConfig, MarketMode } from './band-config.js';
import { DUST_FLOOR_USDS, maxWithdrawableWithReserve } from './allocation-logic.js';

const USDS_WAD = 10n ** 18n;
const SEC_PER_HOUR = 3_600;

/**
 * satAPY = SAT_APY_FACTOR x anchorAPY: at the IRM's 90% target utilization suppliers
 * earn the borrow rate on 90% of their capital (fee is 0 on all Flagship markets).
 */
const SAT_APY_FACTOR = 0.9;

/**
 * Anchor reads above this are garbage: the Adaptive Curve IRM caps rateAtTarget at
 * 200% APR on-chain, which compounds to ~639% APY — 1000% is unreachable, so
 * anything beyond it is a corrupted read, not a hot market.
 */
const MAX_SANE_ANCHOR_APY = 10;

export interface MarketObservation {
  index: number; name: string; mode: MarketMode;
  // Per-market SSR_t margin override (bps). Falls back to cfg.ssrTMarginBps when unset.
  ssrTMarginBps?: number;
  totalSupplyAssets: bigint; totalBorrowAssets: bigint;  // accrued market totals
  vaultAssets: bigint;                                    // adapter position in this market
  anchorApy: number;                                      // rateAtTarget as APY, 0.0352 = 3.52%
  // Bands-mode cap from env (computeMarketCap). A position above it is a cap breach.
  // Undefined when the market has no env cap: then only the on-chain relative cap
  // bounds its deposits, and it never emits a priority withdrawal.
  marketCap?: bigint;
  // Deposit ceiling this cycle: min(on-chain relative cap with headroom, marketCap).
  effectiveCap: bigint;
  lastAllocateAtSec?: number; lastDeallocateAtSec?: number; // undefined = none in lookback window
}

/** Machine-readable trace key for the decision a market ended on. */
export type BandRule =
  | 'R-BAND90' | 'R-BAND92' | 'R-BAND93' | 'R-BAND94' | 'R-BAND95'
  | 'R-HOLD' | 'R-DEADBAND' | 'R-MINACTION' | 'R-COOLDOWN' | 'R-SHARE' | 'R-RETIRED'
  | 'R-PRIORITY-DEPOSIT' | 'R-PRIORITY-WITHDRAWAL';

export interface BandDecision {
  index: number;
  targetAmount: bigint;      // absolute vault target for this market this cycle
  bandUtilBps?: number;      // util the market is held to; undefined when there is no band (holds, priority wishes)
  // Served before the ordinary wishes in reconciliation: a priority deposit (PRIMARY
  // fill) or a priority withdrawal (cap breach). Always false on a hold.
  priority: boolean;
  rule: BandRule;
  reasons: string[];         // human-readable inputs that fired the rule (include resolved absolute thresholds)
}

/** A gate's verdict: the hold rule and why, or undefined to let the wish through. */
type Hold = { rule: BandRule; why: string };

/** ceil(a / b) for non-negative bigints. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Market utilization in bps, floor division (borrow * 10000 / supply).
 * An empty market reads as 0 utilization.
 */
function utilizationBps(totalSupplyAssets: bigint, totalBorrowAssets: bigint): number {
  if (totalSupplyAssets <= 0n) return 0;
  return Number((totalBorrowAssets * 10000n) / totalSupplyAssets);
}

/** Format an APY fraction for decision traces, e.g. 0.0352 -> "3.520%". */
function fmtPct(x: number): string {
  return `${(x * 100).toFixed(3)}%`;
}

/** Format an 18-dec amount as whole USDS for decision traces (display truncation only). */
function fmtUsds(x: bigint): string {
  return `${x / USDS_WAD} USDS`;
}

/** Format a signed 18-dec delta for decision traces. */
function fmtSignedUsds(x: bigint): string {
  return x < 0n ? `-${fmtUsds(-x)}` : `+${fmtUsds(x)}`;
}

function fmtUtc(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** A no-action decision: the market keeps its position. */
function holdAt(m: MarketObservation, rule: BandRule, bandUtilBps: number | undefined, reasons: string[]): BandDecision {
  return { index: m.index, targetAmount: m.vaultAssets, bandUtilBps, priority: false, rule, reasons };
}

type BandUtil = 9000 | 9200 | 9300 | 9400 | 9500;

const BAND_RULE: Record<BandUtil, BandRule> = {
  9000: 'R-BAND90', 9200: 'R-BAND92', 9300: 'R-BAND93', 9400: 'R-BAND94', 9500: 'R-BAND95',
};

/**
 * Utilization band (bps) for a market given its satAPY, or 'HOLD' inside the
 * satisfaction zone. Every threshold derives from SSR_t, so a governance SSR change
 * moves the whole ladder automatically:
 *
 *   satAPY >  SSR_t + tolerance   -> 9000  (rate rich — top up from idle as demand grows)
 *   satAPY >= SSR_t - tolerance   -> HOLD  (zone [SSR - 25, SSR + 25] bps at defaults)
 *   satAPY >= 2/3  x SSR_t        -> 9200
 *   satAPY >= 1/3  x SSR_t        -> 9300
 *   satAPY >= 1/12 x SSR_t        -> 9400
 *   otherwise                     -> 9500  (deepest heating)
 */
function pickBand(satApy: number, ssrTApy: number, toleranceApy: number): BandUtil | 'HOLD' {
  if (satApy > ssrTApy + toleranceApy) return 9000;
  if (satApy >= ssrTApy - toleranceApy) return 'HOLD';
  if (satApy >= (2 / 3) * ssrTApy) return 9200;
  if (satApy >= (1 / 3) * ssrTApy) return 9300;
  if (satApy >= (1 / 12) * ssrTApy) return 9400;
  return 9500;
}

/**
 * Shared sizing step 1 — bound a wished vault target to what the vault can hold:
 * never negative, and a grow stops at effectiveCap (above it the allocate would
 * revert). The cap never turns a grow into a drain: a position already above it
 * stays put, since only a breach of the bands-mode cap (priority withdrawal) may
 * drain on cap grounds.
 */
function boundTarget(m: MarketObservation, uncapped: bigint, reasons: string[]): bigint {
  const target = uncapped < 0n ? 0n : uncapped;
  if (target > m.vaultAssets && target > m.effectiveCap) {
    reasons.push(`grow clamped to effectiveCap ${fmtUsds(m.effectiveCap)}`);
    return m.effectiveCap > m.vaultAssets ? m.effectiveCap : m.vaultAssets;
  }
  return target;
}

/**
 * Shared sizing step 2 — the hold gates every sized wish passes, in order:
 *   |delta| < minBandActionUsds                                        -> R-MINACTION
 *   grow after a deallocate, or drain after an allocate,
 *     within directionCooldownHours ("within" = strictly less)         -> R-COOLDOWN
 */
function sizeGate(m: MarketObservation, cfg: BandConfig, nowSec: number, delta: bigint): Hold | undefined {
  const absDelta = delta < 0n ? -delta : delta;
  if (absDelta < cfg.minBandActionUsds) {
    return { rule: 'R-MINACTION', why: `|delta| ${fmtUsds(absDelta)} < min action ${fmtUsds(cfg.minBandActionUsds)} -> hold` };
  }
  const cooldownSec = cfg.directionCooldownHours * SEC_PER_HOUR;
  if (delta > 0n && m.lastDeallocateAtSec !== undefined && nowSec - m.lastDeallocateAtSec < cooldownSec) {
    return {
      rule: 'R-COOLDOWN',
      why: `grow ${nowSec - m.lastDeallocateAtSec}s after last deallocate (${fmtUtc(m.lastDeallocateAtSec)}) ` +
        `< direction cooldown ${cfg.directionCooldownHours}h -> hold`,
    };
  }
  if (delta < 0n && m.lastAllocateAtSec !== undefined && nowSec - m.lastAllocateAtSec < cooldownSec) {
    return {
      rule: 'R-COOLDOWN',
      why: `drain ${nowSec - m.lastAllocateAtSec}s after last allocate (${fmtUtc(m.lastAllocateAtSec)}) ` +
        `< direction cooldown ${cfg.directionCooldownHours}h -> hold`,
    };
  }
  return undefined;
}

/**
 * Shared sizing step 3 — bound this cycle's fund movement: a grow to maxAllocateUsds,
 * a drain to maxDeallocateUsds. Returns the final delta; a clamp is recorded in
 * reasons, the rule is unchanged.
 */
function clampToStepCaps(cfg: BandConfig, delta: bigint, reasons: string[]): bigint {
  if (delta > cfg.maxAllocateUsds) {
    reasons.push(`grow ${fmtUsds(delta)} clamped to step cap MAX_ALLOCATE ${fmtUsds(cfg.maxAllocateUsds)}`);
    return cfg.maxAllocateUsds;
  }
  if (-delta > cfg.maxDeallocateUsds) {
    reasons.push(`drain ${fmtUsds(-delta)} clamped to step cap MAX_DEALLOCATE ${fmtUsds(cfg.maxDeallocateUsds)}`);
    return -cfg.maxDeallocateUsds;
  }
  return delta;
}

/** Steering gate: |utilBps - band| <= deadband (inclusive) -> R-DEADBAND. */
function deadbandGate(utilBps: number, band: BandUtil, cfg: BandConfig): Hold | undefined {
  if (Math.abs(utilBps - band) > cfg.utilDeadbandBps) return undefined;
  return { rule: 'R-DEADBAND', why: `|util ${utilBps} - band ${band}| <= deadband ${cfg.utilDeadbandBps} bps -> hold` };
}

/**
 * Steering gate, drains only: vault share < monopolistShareBps -> R-SHARE (we are
 * not the dominant supplier, draining cannot move util — go neutral; grows are
 * still allowed).
 */
function shareGate(m: MarketObservation, cfg: BandConfig, delta: bigint): Hold | undefined {
  if (delta >= 0n) return undefined;
  const shareBps = m.totalSupplyAssets > 0n ? Number((m.vaultAssets * 10000n) / m.totalSupplyAssets) : 0;
  if (shareBps >= cfg.monopolistShareBps) return undefined;
  return {
    rule: 'R-SHARE',
    why: `vault share ${shareBps} bps < monopolist threshold ${cfg.monopolistShareBps} bps — ` +
      `draining cannot move util, go neutral -> hold`,
  };
}

/**
 * Smallest priority withdrawal worth a transaction: minPriorityWithdrawalUsds, or the
 * dust floor for a zero-cap market (it must end up holding nothing, but a residue
 * under the floor is not worth chasing with more Safe txs).
 */
function priorityWithdrawalThreshold(marketCap: bigint, cfg: BandConfig): bigint {
  return marketCap === 0n ? DUST_FLOOR_USDS : cfg.minPriorityWithdrawalUsds;
}

/** Whether the position breaches the cap by at least the priority-withdrawal threshold. */
function isActionableBreach(m: MarketObservation, marketCap: bigint, cfg: BandConfig): boolean {
  return m.vaultAssets - marketCap >= priorityWithdrawalThreshold(marketCap, cfg);
}

/**
 * Priority withdrawal: the position sits above the market's cap (a cap or TVL drop,
 * or a governance cap cut) by at least the threshold. Wish the excess back out,
 * bounded by what the pool can pay right now — a drain the executor would have to
 * shrink to the pool's liquidity would have already been credited to the deposit
 * budget in reconciliation, and the batch guard would abort every cycle. A slice
 * the liquidity leaves under the threshold is held for the same reason: it would
 * fund deposits in reconciliation and then be dropped. The wish skips every
 * steering gate: a breach is a policy violation, not a rate signal, so the
 * deadband, the direction cooldown and the monopolist share have nothing to say
 * about it. Only the pool's withdrawable liquidity and the MAX_DEALLOCATE step cap
 * bound it.
 */
function decidePriorityWithdrawal(
  m: MarketObservation, marketCap: bigint, cfg: BandConfig, liquidityReservePercent: bigint,
): BandDecision {
  const breach = m.vaultAssets - marketCap;
  const threshold = priorityWithdrawalThreshold(marketCap, cfg);
  const withdrawable = maxWithdrawableWithReserve(m.totalSupplyAssets, m.totalBorrowAssets, liquidityReservePercent);
  const reasons = [
    `position ${fmtUsds(m.vaultAssets)} above cap ${fmtUsds(marketCap)} by ${fmtUsds(breach)} ` +
    `(>= ${marketCap === 0n ? 'dust floor' : 'min priority withdrawal'} ${fmtUsds(threshold)}) -> priority withdrawal`,
  ];
  let drain = breach;
  if (drain > withdrawable) {
    drain = withdrawable;
    reasons.push(`drain clamped to withdrawable liquidity ${fmtUsds(withdrawable)} (${liquidityReservePercent}% reserve)`);
  }
  if (drain < threshold) {
    return holdAt(m, 'R-PRIORITY-WITHDRAWAL', undefined, [...reasons,
      `withdrawable slice ${fmtUsds(drain)} < ${fmtUsds(threshold)} -> hold, retry next cycle`]);
  }
  const delta = clampToStepCaps(cfg, -drain, reasons);
  return {
    index: m.index, targetAmount: m.vaultAssets + delta, bandUtilBps: undefined,
    priority: true, rule: 'R-PRIORITY-WITHDRAWAL', reasons,
  };
}

/**
 * Priority deposit (PRIMARY): the market is the vault's bootstrap destination, so it
 * always asks for the whole gap up to its deposit ceiling. No band and no rate input:
 * satAPY plays no role. At or above the ceiling the market holds (draining back to
 * the cap is the priority-withdrawal rule's job); otherwise the gap is sized by the
 * shared steps.
 */
function decidePriorityDeposit(m: MarketObservation, cfg: BandConfig, nowSec: number): BandDecision {
  const reasons: string[] = [];
  const delta = boundTarget(m, m.effectiveCap, reasons) - m.vaultAssets;
  reasons.unshift(
    `mode=PRIMARY: fill to effectiveCap ${fmtUsds(m.effectiveCap)} from ${fmtUsds(m.vaultAssets)} ` +
    `(delta ${fmtSignedUsds(delta)})`
  );
  if (delta <= 0n) {
    return holdAt(m, 'R-HOLD', undefined, [...reasons, 'at/above effectiveCap -> hold']);
  }
  const gate = sizeGate(m, cfg, nowSec, delta);
  if (gate) return holdAt(m, gate.rule, undefined, [...reasons, gate.why]);
  const step = clampToStepCaps(cfg, delta, reasons);
  return {
    index: m.index, targetAmount: m.vaultAssets + step, bandUtilBps: undefined,
    priority: true, rule: 'R-PRIORITY-DEPOSIT', reasons,
  };
}

/**
 * Steering (STEERED): pick the band from satAPY (HOLD inside the zone), invert it
 * into an absolute vault target and size the wish through the shared steps, with
 * the two steering-only gates around the shared one (each hold carries its own
 * rule): deadband -> min action -> cooldown -> share -> step caps.
 */
function decideSteered(m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number): BandDecision {
  if (!Number.isFinite(m.anchorApy) || m.anchorApy < 0 || m.anchorApy > MAX_SANE_ANCHOR_APY) {
    // The whole ladder keys off satAPY = 0.9 x anchor, so a corrupted rateAtTarget
    // read would steer real funds off garbage. Abort the cycle instead.
    throw new Error(
      `${m.name}: anchor APY ${m.anchorApy} is outside [0, ${MAX_SANE_ANCHOR_APY}] — ` +
      `refusing to steer off a suspect read`
    );
  }
  const marginBps = m.ssrTMarginBps ?? cfg.ssrTMarginBps;
  const ssrT = ssrApy + marginBps / 10000;
  const toleranceApy = cfg.ssrTToleranceBps / 10000;
  const satApy = SAT_APY_FACTOR * m.anchorApy;
  const ssrTDesc =
    `SSR ${fmtPct(ssrApy)} + ${marginBps} bps${m.ssrTMarginBps !== undefined ? ' (per-market override)' : ''}`;

  const band = pickBand(satApy, ssrT, toleranceApy);
  if (band === 'HOLD') {
    return holdAt(m, 'R-HOLD', undefined, [
      `satApy ${fmtPct(satApy)} (0.9 x anchor ${fmtPct(m.anchorApy)}) inside zone ` +
      `[${fmtPct(ssrT - toleranceApy)}, ${fmtPct(ssrT + toleranceApy)}] ` +
      `(SSR_t ${fmtPct(ssrT)} = ${ssrTDesc}) -> hold`,
    ]);
  }

  const reasons: string[] = [
    `satApy ${fmtPct(satApy)} (0.9 x anchor ${fmtPct(m.anchorApy)}) vs SSR_t ${fmtPct(ssrT)} ` +
    `+- ${fmtPct(toleranceApy)} (${ssrTDesc}) -> band ${band} bps`,
  ];

  // Invert the band into an absolute vault target; ceil keeps the resulting
  // utilization from rounding ABOVE the band.
  const targetSupplyTotal = ceilDiv(m.totalBorrowAssets * 10000n, BigInt(band));
  const targetVault = boundTarget(m, m.vaultAssets + targetSupplyTotal - m.totalSupplyAssets, reasons);
  const delta = targetVault - m.vaultAssets;
  const utilBps = utilizationBps(m.totalSupplyAssets, m.totalBorrowAssets);
  reasons.push(
    `util ${utilBps} bps, band ${band} bps -> vault target ${fmtUsds(targetVault)} (delta ${fmtSignedUsds(delta)})`
  );

  const gate = deadbandGate(utilBps, band, cfg) ?? sizeGate(m, cfg, nowSec, delta) ?? shareGate(m, cfg, delta);
  if (gate) return holdAt(m, gate.rule, band, [...reasons, gate.why]);
  const step = clampToStepCaps(cfg, delta, reasons);
  return { index: m.index, targetAmount: m.vaultAssets + step, bandUtilBps: band, priority: false, rule: BAND_RULE[band], reasons };
}

/** Single-market decision by mode, with the priority-withdrawal rule ahead of any steering. */
function decideMarket(
  m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number, liquidityReservePercent: bigint,
): BandDecision {
  if (m.mode === 'RETIRED') {
    return holdAt(m, 'R-RETIRED', undefined,
      [`mode=RETIRED — the bot never touches this market (position ${fmtUsds(m.vaultAssets)})`]);
  }
  if (m.mode === 'SOUNDING') {
    // parseMarketMode already refuses to start with a SOUNDING market; a decision
    // request for one means the config/observation plumbing is broken.
    throw new Error(`${m.name}: mode=SOUNDING is not implemented`);
  }
  if (m.marketCap !== undefined && isActionableBreach(m, m.marketCap, cfg)) {
    return decidePriorityWithdrawal(m, m.marketCap, cfg, liquidityReservePercent);
  }
  if (m.mode === 'PRIMARY') {
    return decidePriorityDeposit(m, cfg, nowSec);
  }
  return decideSteered(m, cfg, ssrApy, nowSec);
}

/**
 * Compute one BandDecision per market observation (same order as the input array).
 * Pure: same inputs -> same decisions. The decisions are per-market wishes; reconcile
 * them against the vault-level sleeve limits with reconcileToVaultLimits before
 * executing.
 *
 * @param args.markets per-market observations (fresh, accrued state)
 * @param args.cfg     validated band configuration (parseBandConfig output)
 * @param args.ssrApy  SSR as an APY fraction (computeSsrApy output, sanity-checked)
 * @param args.nowSec  current UTC unix seconds
 * @param args.liquidityReservePercent share of a pool's supply the executor keeps as
 *   a withdrawal cushion (LIQUIDITY_RESERVE_PERCENT); priority withdrawals are sized
 *   to the same rule so the plan never promises liquidity the executor will refuse
 */
export function computeBandDecisions(args: {
  markets: MarketObservation[];
  cfg: BandConfig;
  ssrApy: number;
  nowSec: number;
  liquidityReservePercent: bigint;
}): BandDecision[] {
  const { markets, cfg, ssrApy, nowSec, liquidityReservePercent } = args;
  return markets.map(m => decideMarket(m, cfg, ssrApy, nowSec, liquidityReservePercent));
}
