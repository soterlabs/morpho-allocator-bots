/**
 * Pure per-market band-steering decision engine for the Flagship Vault Allocator Bot.
 *
 * Turns per-market observations + BandConfig + the on-chain SSR into one BandDecision
 * per market. PURE by design: no RPC, no env reads — the entire fund-affecting decision
 * surface is unit-testable, and the executor is a thin map from BandDecision ->
 * on-chain allocate/deallocate.
 *
 * Per STEERED market:
 *
 *   1. satAPY = 0.9 x anchorAPY — the supply APY the market pays at its 90% target
 *      utilization (fee-0 approximation of rateAtTarget as a supplier rate).
 *   2. Choose the utilization band from satAPY vs thresholds derived from
 *      SSR_t = SSR + margin (see pickBand). Inside the SSR_t +- tolerance zone the
 *      market HOLDs — no action.
 *   3. Invert the band into an absolute vault target
 *      (targetSupply = ceil(borrow / band), clamped to [0, effectiveCap]) and run the
 *      hold gates in order: utilization deadband, min action, direction cooldown,
 *      monopolist share; a surviving delta is clamped to the per-cycle step caps.
 *
 * RETIRED markets are never touched. SOUNDING is rejected at startup
 * (market-config.ts parseMarketMode) and defensively rejected here too.
 *
 * Vault-level reconciliation of the resulting wish list against the sleeve limits
 * (spec "krok 4") lives in reconcile.ts.
 *
 * All timestamps are UTC unix seconds. All amounts are 18-dec USDS.
 */

import type { BandConfig, MarketMode } from './band-config.js';

const USDS_WAD = 10n ** 18n;
const SEC_PER_HOUR = 3_600;

/**
 * satAPY = SAT_APY_FACTOR x anchorAPY: at the IRM's 90% target utilization suppliers
 * earn the borrow rate on 90% of their capital (fee is 0 on all Flagship markets).
 */
const SAT_APY_FACTOR = 0.9;

export interface MarketObservation {
  index: number; name: string; mode: MarketMode;
  // Per-market SSR_t margin override (bps). Falls back to cfg.ssrTMarginBps when unset.
  ssrTMarginBps?: number;
  totalSupplyAssets: bigint; totalBorrowAssets: bigint;  // accrued market totals
  vaultAssets: bigint;                                    // adapter position in this market
  anchorApy: number;                                      // rateAtTarget as APY, 0.0352 = 3.52%
  effectiveCap: bigint;                                   // min(on-chain cap w/ headroom, off-chain absolute cap)
  lastAllocateAtSec?: number; lastDeallocateAtSec?: number; // undefined = none in lookback window
}

export interface BandDecision {
  index: number;
  targetAmount: bigint;      // absolute vault target for this market this cycle
  bandUtilBps?: number;      // util the market is held to; undefined when there is no band (HOLD / RETIRED)
  rule: string;              // 'R-BAND90'|'R-HOLD'|'R-BAND92'|'R-BAND93'|'R-BAND94'|'R-BAND95'|'R-DEADBAND'|'R-MINACTION'|'R-COOLDOWN'|'R-SHARE'|'R-RETIRED'
  reasons: string[];         // human-readable inputs that fired the rule (include resolved absolute thresholds)
}

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

/**
 * Utilization band (bps) for a market given its satAPY, or 'HOLD' inside the
 * satisfaction zone. Every threshold derives from SSR_t, so a governance SSR change
 * moves the whole ladder automatically:
 *
 *   satAPY >  SSR_t + tolerance   -> 9000  (rate rich — top up from idle as demand grows)
 *   satAPY >= SSR_t - tolerance   -> HOLD  (zone edges: [SSR, SSR + 2 x margin] at defaults)
 *   satAPY >= 2/3  x SSR_t        -> 9200
 *   satAPY >= 1/3  x SSR_t        -> 9300
 *   satAPY >= 1/12 x SSR_t        -> 9400
 *   otherwise                     -> 9500  (deepest heating)
 */
export function pickBand(satApy: number, ssrTApy: number, toleranceApy: number): number | 'HOLD' {
  if (satApy > ssrTApy + toleranceApy) return 9000;
  if (satApy >= ssrTApy - toleranceApy) return 'HOLD';
  if (satApy >= (2 / 3) * ssrTApy) return 9200;
  if (satApy >= (1 / 3) * ssrTApy) return 9300;
  if (satApy >= (1 / 12) * ssrTApy) return 9400;
  return 9500;
}

/**
 * STEERED decision: pick the band from satAPY (HOLD inside the zone), invert it into
 * an absolute vault target, then run the hold gates IN ORDER (each converts the
 * decision to a hold carrying its own rule):
 *
 *   |utilBps - band| <= deadband                            -> R-DEADBAND
 *   |delta| < minBandActionUsds                             -> R-MINACTION
 *   grow after a deallocate (or drain after an allocate)
 *     within directionCooldownHours                         -> R-COOLDOWN
 *   drain while vault share < monopolistShareBps            -> R-SHARE
 *     (we are not the dominant supplier, draining cannot move util — go neutral;
 *      grows are still allowed)
 *
 * A surviving grow is clamped to maxAllocateUsds, a surviving drain to
 * maxDeallocateUsds (rule unchanged — the clamp is recorded in reasons).
 */
function decideSteered(m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number): BandDecision {
  const marginBps = m.ssrTMarginBps ?? cfg.ssrTMarginBps;
  const ssrT = ssrApy + marginBps / 10000;
  const toleranceApy = cfg.ssrTToleranceBps / 10000;
  const satApy = SAT_APY_FACTOR * m.anchorApy;

  const band = pickBand(satApy, ssrT, toleranceApy);
  if (band === 'HOLD') {
    return {
      index: m.index, targetAmount: m.vaultAssets, bandUtilBps: undefined,
      rule: 'R-HOLD',
      reasons: [
        `satApy ${fmtPct(satApy)} (0.9 x anchor ${fmtPct(m.anchorApy)}) inside zone ` +
        `[${fmtPct(ssrT - toleranceApy)}, ${fmtPct(ssrT + toleranceApy)}] ` +
        `(SSR_t ${fmtPct(ssrT)} = SSR ${fmtPct(ssrApy)} + ${marginBps} bps` +
        `${m.ssrTMarginBps !== undefined ? ', per-market override' : ''}) -> hold`,
      ],
    };
  }

  const rule = `R-BAND${band / 100}`;
  const reasons: string[] = [
    `satApy ${fmtPct(satApy)} (0.9 x anchor ${fmtPct(m.anchorApy)}) vs SSR_t ${fmtPct(ssrT)} ` +
    `+- ${fmtPct(toleranceApy)} (SSR ${fmtPct(ssrApy)} + ${marginBps} bps` +
    `${m.ssrTMarginBps !== undefined ? ', per-market override' : ''}) -> band ${band} bps`,
  ];

  // Invert the band into an absolute vault target. ceil keeps the resulting
  // utilization from rounding ABOVE the band; the target is clamped to
  // [0, effectiveCap] (a vault cannot hold a negative position, and a target above
  // the cap could not be allocated anyway).
  const targetSupplyTotal = ceilDiv(m.totalBorrowAssets * 10000n, BigInt(band));
  const uncapped = m.vaultAssets + targetSupplyTotal - m.totalSupplyAssets;
  let targetVault = uncapped < 0n ? 0n : uncapped;
  if (targetVault > m.effectiveCap) {
    targetVault = m.effectiveCap;
    reasons.push(`target clamped to effectiveCap ${fmtUsds(m.effectiveCap)}`);
  }
  const delta = targetVault - m.vaultAssets;
  const utilBps = utilizationBps(m.totalSupplyAssets, m.totalBorrowAssets);
  reasons.push(
    `util ${utilBps} bps, band ${band} bps -> vault target ${fmtUsds(targetVault)} ` +
    `(delta ${fmtSignedUsds(delta)})`
  );

  const hold = (holdRule: string, why: string): BandDecision => ({
    index: m.index, targetAmount: m.vaultAssets, bandUtilBps: band,
    rule: holdRule, reasons: [...reasons, why],
  });

  // Gate 1: utilization deadband (inclusive).
  if (Math.abs(utilBps - band) <= cfg.utilDeadbandBps) {
    return hold('R-DEADBAND', `|util ${utilBps} - band ${band}| <= deadband ${cfg.utilDeadbandBps} bps -> hold`);
  }
  // Gate 2: minimum steering action.
  const absDelta = delta < 0n ? -delta : delta;
  if (absDelta < cfg.minBandActionUsds) {
    return hold('R-MINACTION', `|delta| ${fmtUsds(absDelta)} < min action ${fmtUsds(cfg.minBandActionUsds)} -> hold`);
  }
  // Gate 3: direction-change cooldown ("within" = strictly less than the cooldown).
  const cooldownSec = cfg.directionCooldownHours * SEC_PER_HOUR;
  if (delta > 0n && m.lastDeallocateAtSec !== undefined && nowSec - m.lastDeallocateAtSec < cooldownSec) {
    return hold('R-COOLDOWN',
      `grow ${nowSec - m.lastDeallocateAtSec}s after last deallocate (${fmtUtc(m.lastDeallocateAtSec)}) ` +
      `< direction cooldown ${cfg.directionCooldownHours}h -> hold`);
  }
  if (delta < 0n && m.lastAllocateAtSec !== undefined && nowSec - m.lastAllocateAtSec < cooldownSec) {
    return hold('R-COOLDOWN',
      `drain ${nowSec - m.lastAllocateAtSec}s after last allocate (${fmtUtc(m.lastAllocateAtSec)}) ` +
      `< direction cooldown ${cfg.directionCooldownHours}h -> hold`);
  }
  // Gate 4: monopolist share — drains only.
  if (delta < 0n) {
    const shareBps = m.totalSupplyAssets > 0n
      ? Number((m.vaultAssets * 10000n) / m.totalSupplyAssets)
      : 0;
    if (shareBps < cfg.monopolistShareBps) {
      return hold('R-SHARE',
        `vault share ${shareBps} bps < monopolist threshold ${cfg.monopolistShareBps} bps — ` +
        `draining cannot move util, go neutral -> hold`);
    }
  }

  // Step caps: bound this cycle's fund movement. Rule unchanged, clamp traced in reasons.
  if (delta > 0n && delta > cfg.maxAllocateUsds) {
    targetVault = m.vaultAssets + cfg.maxAllocateUsds;
    reasons.push(`grow ${fmtUsds(delta)} clamped to step cap MAX_ALLOCATE ${fmtUsds(cfg.maxAllocateUsds)}`);
  } else if (delta < 0n && -delta > cfg.maxDeallocateUsds) {
    targetVault = m.vaultAssets - cfg.maxDeallocateUsds;
    reasons.push(`drain ${fmtUsds(-delta)} clamped to step cap MAX_DEALLOCATE ${fmtUsds(cfg.maxDeallocateUsds)}`);
  }

  return { index: m.index, targetAmount: targetVault, bandUtilBps: band, rule, reasons };
}

/** Single-market decision by mode. */
function decideMarket(m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number): BandDecision {
  if (m.mode === 'RETIRED') {
    return {
      index: m.index, targetAmount: m.vaultAssets, bandUtilBps: undefined,
      rule: 'R-RETIRED',
      reasons: [`mode=RETIRED — the bot never touches this market (position ${fmtUsds(m.vaultAssets)})`],
    };
  }
  if (m.mode === 'SOUNDING') {
    // parseMarketMode already refuses to start with a SOUNDING market; a decision
    // request for one means the config/observation plumbing is broken.
    throw new Error(`${m.name}: mode=SOUNDING is not implemented`);
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
 */
export function computeBandDecisions(args: {
  markets: MarketObservation[];
  cfg: BandConfig;
  ssrApy: number;
  nowSec: number;
}): BandDecision[] {
  const { markets, cfg, ssrApy, nowSec } = args;
  return markets.map(m => decideMarket(m, cfg, ssrApy, nowSec));
}
