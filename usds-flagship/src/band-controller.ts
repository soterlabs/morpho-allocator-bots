/**
 * Pure band-steering decision engine for the Flagship Vault Allocator Bot (Phase A).
 *
 * Turns per-market observations + BandConfig + the SSR anchor into one BandDecision per
 * market. PURE by design: no RPC, no env reads, no imports beyond TYPES from
 * band-config.js — the entire fund-affecting decision surface is unit-testable, and the
 * executor is a thin map from BandDecision -> on-chain allocate/deallocate.
 *
 * Decision algorithm (DECIDED 2026-07-30), applied per market and then as a whole-vector
 * sleeve-floor pass:
 *
 *   (1) RETIRED           -> target 0, sweep, held at the drain band          (R-RETIRED)
 *   (2) winddown overlay when maturityUtcSec is set:
 *         now >= maturity - 14d -> same as RETIRED                            (R-WD14)
 *         now >= maturity - 30d -> grows blocked; a would-be grow holds       (R-WD30)
 *   (3) SOUNDING          -> feed a tranche while demand "sticks" (util >= stick gate)
 *                            and the feed cooldown has passed; never drains
 *                                                              (R-SND-FEED / R-SND-HOLD)
 *   (4) STEERED           -> classify into a utilization band off SSR, invert the band
 *                            to a vault target, then run the hold gates in order:
 *                            deadband, min-action, direction cooldown, monopolist share
 *              (R-HARV / R-DRAIN94 / R-HIGH92 / R-MID93, holds via R-DEADBAND /
 *               R-MINACTION / R-COOLDOWN / R-SHARE), then clamp to the per-cycle
 *               step caps (MAX_ALLOCATE_USDS / MAX_DEALLOCATE_USDS)
 *   (5) SLEEVE FLOOR pass -> if the summed targets fall below sleeveFloorBps of
 *                            totalAssets, restore STEERED drains (largest first) back
 *                            toward the current position until the floor is met;
 *                            RETIRED/winddown sweeps are never restored ('R-FLOOR'
 *                            appended to reasons, rule unchanged)
 *
 * All timestamps are UTC unix seconds. All amounts are 18-dec USDS.
 */

import type { BandConfig, MarketMode } from './band-config.js';

const USDS_WAD = 10n ** 18n;
const DAY_SEC = 86_400;
const SEC_PER_HOUR = 3_600;

export interface MarketObservation {
  index: number; name: string; mode: MarketMode;
  maturityUtcSec?: number;
  totalSupplyAssets: bigint; totalBorrowAssets: bigint;  // accrued market totals
  vaultAssets: bigint;                                    // adapter position in this market
  supplyApy: number;                                      // instantaneous, 0.0247 = 2.47%
  anchorApy: number;                                      // rateAtTarget as APY
  effectiveCap: bigint;                                   // min(on-chain cap w/ headroom, off-chain absolute cap)
  lastAllocateAtSec?: number; lastDeallocateAtSec?: number; // undefined = none in lookback window
}

export interface BandDecision {
  index: number;
  targetAmount: bigint;      // absolute vault target for this market this cycle
  bandUtilBps?: number;      // util this market is held to (feeds MarketLiquidity.maxUtilizationBps); undefined for SOUNDING grows
  sweep: boolean;            // drain-to-zero semantics (RETIRED / T-14 winddown)
  rule: string;              // 'R-HARV'|'R-DRAIN94'|'R-HIGH92'|'R-MID93'|'R-SND-FEED'|'R-SND-HOLD'|'R-RETIRED'|'R-WD30'|'R-WD14'|'R-COOLDOWN'|'R-DEADBAND'|'R-MINACTION'|'R-SHARE'|'R-FLOOR'
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

type WinddownPhase = 'none' | 'grow-blocked' | 'drain';

/**
 * PT-market winddown phase relative to maturity:
 *   now >= maturity - 14d -> 'drain' (market drains like RETIRED)
 *   now >= maturity - 30d -> 'grow-blocked' (holds are fine, grows are not)
 * Boundaries are inclusive (>=).
 */
function winddownPhase(maturityUtcSec: number | undefined, nowSec: number): WinddownPhase {
  if (maturityUtcSec === undefined) return 'none';
  if (nowSec >= maturityUtcSec - 14 * DAY_SEC) return 'drain';
  if (nowSec >= maturityUtcSec - 30 * DAY_SEC) return 'grow-blocked';
  return 'none';
}

/**
 * SOUNDING decision: depth-sound a new market by feeding fixed tranches while demand
 * "sticks" (utilization pinned at/above the stick gate) and the feed cooldown has
 * passed. Tranche sizing: below the first-tranche level, top UP to it (first feed lands
 * the position exactly at soundingFirstTrancheUsds); at/above it, add the follow-up
 * tranche. The grow is clamped by maxAllocateUsds then by effectiveCap. SOUNDING never
 * drains: if effectiveCap sits below the current position the target clamps back up to
 * the current position (an explicit hold, not a drain). The rule reports the REALIZED
 * action direction: when the clamps reduce a would-be feed to no movement (e.g.
 * effectiveCap at/below the current position), the decision is R-SND-HOLD, not a
 * phantom R-SND-FEED — the rule field is the machine-readable trace key, and it must
 * match what the cycle actually does; the reasons still explain the clamp.
 * bandUtilBps is undefined — a sounding market is not held to a band.
 */
function decideSounding(m: MarketObservation, cfg: BandConfig, nowSec: number): BandDecision {
  const utilBps = utilizationBps(m.totalSupplyAssets, m.totalBorrowAssets);
  const cooldownSec = cfg.soundingFeedCooldownHours * SEC_PER_HOUR;
  const sinceAllocateSec = m.lastAllocateAtSec === undefined ? undefined : nowSec - m.lastAllocateAtSec;

  if (utilBps < cfg.soundingStickUtilBps) {
    return {
      index: m.index, targetAmount: m.vaultAssets, bandUtilBps: undefined, sweep: false,
      rule: 'R-SND-HOLD',
      reasons: [
        `util ${utilBps} bps < stick gate ${cfg.soundingStickUtilBps} bps — demand not sticking, hold ${fmtUsds(m.vaultAssets)}`,
      ],
    };
  }
  if (sinceAllocateSec !== undefined && sinceAllocateSec < cooldownSec) {
    return {
      index: m.index, targetAmount: m.vaultAssets, bandUtilBps: undefined, sweep: false,
      rule: 'R-SND-HOLD',
      reasons: [
        `util ${utilBps} bps >= stick gate ${cfg.soundingStickUtilBps} bps but last feed ` +
        `${sinceAllocateSec}s ago < feed cooldown ${cfg.soundingFeedCooldownHours}h — hold ${fmtUsds(m.vaultAssets)}`,
      ],
    };
  }

  const belowFirst = m.vaultAssets < cfg.soundingFirstTrancheUsds;
  const tranche = belowFirst
    ? cfg.soundingFirstTrancheUsds - m.vaultAssets
    : cfg.soundingNextTrancheUsds;
  const reasons: string[] = [
    `util ${utilBps} bps >= stick gate ${cfg.soundingStickUtilBps} bps and feed cooldown clear`,
    belowFirst
      ? `tranche ${fmtUsds(tranche)}: top-up to first tranche ${fmtUsds(cfg.soundingFirstTrancheUsds)}`
      : `tranche ${fmtUsds(tranche)}: follow-up feed`,
  ];

  let grow = tranche;
  if (grow > cfg.maxAllocateUsds) {
    grow = cfg.maxAllocateUsds;
    reasons.push(`grow clamped to step cap MAX_ALLOCATE ${fmtUsds(cfg.maxAllocateUsds)}`);
  }
  let target = m.vaultAssets + grow;
  if (target > m.effectiveCap) {
    target = m.effectiveCap;
    reasons.push(`target clamped to effectiveCap ${fmtUsds(m.effectiveCap)}`);
  }
  if (target < m.vaultAssets) {
    // effectiveCap below the current position — SOUNDING never drains, hold instead.
    target = m.vaultAssets;
    reasons.push(`effectiveCap below current position ${fmtUsds(m.vaultAssets)} — SOUNDING never drains, holding`);
  }
  // Rule = realized direction: a feed the clamps reduced to zero movement is a hold.
  const rule = target === m.vaultAssets ? 'R-SND-HOLD' : 'R-SND-FEED';
  return { index: m.index, targetAmount: target, bandUtilBps: undefined, sweep: false, rule, reasons };
}

/**
 * STEERED decision: classify the market into a utilization band off the SSR anchor,
 * invert the band into an absolute vault target, then run the hold gates IN ORDER
 * (each converts the decision to a hold carrying its own rule):
 *
 *   band:  satApy (= 0.9 x anchorApy, the fee-0 supply-at-target approximation)
 *          >= SSR_t (= SSR + margin)          -> harvest band  (R-HARV)
 *          else supplyApy < lowFrac x SSR     -> drain band    (R-DRAIN94)
 *          else supplyApy > highFrac x SSR    -> high band     (R-HIGH92)
 *          else                               -> mid band      (R-MID93)
 *
 *   invert: targetSupplyTotal = ceil(borrow * 10000 / bandUtil) — ceil so the resulting
 *           utilization never rounds ABOVE the band;
 *           targetVault = clamp(vaultAssets + targetSupplyTotal - totalSupplyAssets,
 *                               0, effectiveCap)
 *
 *   gates (in order):
 *     |utilBps - bandUtil| <= deadband                       -> R-DEADBAND
 *     |delta| < minBandActionUsds                            -> R-MINACTION
 *     grow after a deallocate (or drain after an allocate)
 *       within directionCooldownHours                        -> R-COOLDOWN
 *     drain while vault share < monopolistShareBps           -> R-SHARE
 *       (we are not the dominant supplier, draining cannot move util — go neutral;
 *        grows are still allowed)
 *
 *   step caps: a surviving grow is clamped to maxAllocateUsds, a surviving drain to
 *   maxDeallocateUsds (rule unchanged — the clamp is recorded in reasons).
 */
function decideSteered(m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number): BandDecision {
  const ssrT = ssrApy + cfg.ssrTMarginBps / 10000;
  const satApy = 0.9 * m.anchorApy;
  const lowThr = ssrApy * Number(cfg.lowFracNum) / Number(cfg.lowFracDen);
  const highThr = ssrApy * Number(cfg.highFracNum) / Number(cfg.highFracDen);

  let bandUtilBps: number;
  let rule: string;
  const reasons: string[] = [];
  if (satApy >= ssrT) {
    bandUtilBps = cfg.bandUtilHarvestBps;
    rule = 'R-HARV';
    reasons.push(
      `satApy ${fmtPct(satApy)} (0.9 x anchor ${fmtPct(m.anchorApy)}) >= SSR_t ${fmtPct(ssrT)} ` +
      `(SSR ${fmtPct(ssrApy)} + ${cfg.ssrTMarginBps} bps) -> harvest band ${bandUtilBps} bps`
    );
  } else if (m.supplyApy < lowThr) {
    bandUtilBps = cfg.bandUtilDrainBps;
    rule = 'R-DRAIN94';
    reasons.push(
      `supplyApy ${fmtPct(m.supplyApy)} < low threshold ${fmtPct(lowThr)} ` +
      `(${cfg.lowFracNum}/${cfg.lowFracDen} x SSR ${fmtPct(ssrApy)}) -> drain band ${bandUtilBps} bps`
    );
  } else if (m.supplyApy > highThr) {
    bandUtilBps = cfg.bandUtilHighBps;
    rule = 'R-HIGH92';
    reasons.push(
      `supplyApy ${fmtPct(m.supplyApy)} > high threshold ${fmtPct(highThr)} ` +
      `(${cfg.highFracNum}/${cfg.highFracDen} x SSR ${fmtPct(ssrApy)}) -> high band ${bandUtilBps} bps`
    );
  } else {
    bandUtilBps = cfg.bandUtilMidBps;
    rule = 'R-MID93';
    reasons.push(
      `supplyApy ${fmtPct(m.supplyApy)} within [${fmtPct(lowThr)}, ${fmtPct(highThr)}] ` +
      `(${cfg.lowFracNum}/${cfg.lowFracDen}..${cfg.highFracNum}/${cfg.highFracDen} x SSR ${fmtPct(ssrApy)}) ` +
      `-> mid band ${bandUtilBps} bps`
    );
  }

  // Invert the band into an absolute vault target.
  const targetSupplyTotal = ceilDiv(m.totalBorrowAssets * 10000n, BigInt(bandUtilBps));
  const raw = m.vaultAssets + targetSupplyTotal - m.totalSupplyAssets;
  let targetVault = raw < 0n ? 0n : raw;
  if (targetVault > m.effectiveCap) {
    targetVault = m.effectiveCap;
    reasons.push(`target clamped to effectiveCap ${fmtUsds(m.effectiveCap)}`);
  }
  const delta = targetVault - m.vaultAssets;
  const utilBps = utilizationBps(m.totalSupplyAssets, m.totalBorrowAssets);
  reasons.push(
    `util ${utilBps} bps, band ${bandUtilBps} bps -> target supply ${fmtUsds(targetSupplyTotal)}, ` +
    `vault target ${fmtUsds(targetVault)} (delta ${fmtSignedUsds(delta)})`
  );

  const hold = (holdRule: string, why: string): BandDecision => ({
    index: m.index, targetAmount: m.vaultAssets, bandUtilBps, sweep: false,
    rule: holdRule, reasons: [...reasons, why],
  });

  // Gate 1: utilization deadband (inclusive).
  if (Math.abs(utilBps - bandUtilBps) <= cfg.utilDeadbandBps) {
    return hold('R-DEADBAND', `|util ${utilBps} - band ${bandUtilBps}| <= deadband ${cfg.utilDeadbandBps} bps -> hold`);
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

  return { index: m.index, targetAmount: targetVault, bandUtilBps, sweep: false, rule, reasons };
}

/** Single-market decision: RETIRED short-circuit, winddown overlay, then mode dispatch. */
function decideMarket(m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number): BandDecision {
  // (1) RETIRED: drain to zero, held at the drain band while liquidity frees up.
  if (m.mode === 'RETIRED') {
    return {
      index: m.index, targetAmount: 0n, bandUtilBps: cfg.bandUtilDrainBps, sweep: true,
      rule: 'R-RETIRED',
      reasons: [`mode=RETIRED — sweep to zero, held at drain band ${cfg.bandUtilDrainBps} bps`],
    };
  }

  // (2) winddown overlay, part 1: inside T-14d the market drains like RETIRED.
  const phase = winddownPhase(m.maturityUtcSec, nowSec);
  if (phase === 'drain') {
    return {
      index: m.index, targetAmount: 0n, bandUtilBps: cfg.bandUtilDrainBps, sweep: true,
      rule: 'R-WD14',
      reasons: [
        `now ${fmtUtc(nowSec)} >= maturity ${fmtUtc(m.maturityUtcSec!)} - 14d — ` +
        `winddown sweep to zero, held at drain band ${cfg.bandUtilDrainBps} bps`,
      ],
    };
  }

  const base = m.mode === 'SOUNDING'
    ? decideSounding(m, cfg, nowSec)
    : decideSteered(m, cfg, ssrApy, nowSec);

  // (2) winddown overlay, part 2: inside T-30d a would-be grow becomes a hold.
  if (phase === 'grow-blocked' && base.targetAmount > m.vaultAssets) {
    return {
      ...base,
      targetAmount: m.vaultAssets,
      rule: 'R-WD30',
      reasons: [
        ...base.reasons,
        `grow blocked: now ${fmtUtc(nowSec)} >= maturity ${fmtUtc(m.maturityUtcSec!)} - 30d -> hold ${fmtUsds(m.vaultAssets)}`,
      ],
    };
  }
  return base;
}

/**
 * (5) Sleeve-floor pass over the whole decision vector (mutates in place).
 *
 * floor = totalAssets * sleeveFloorBps / 10000. If the summed targets fall below it,
 * restore STEERED drains — raise their targets back toward the current position,
 * LARGEST drains first (ties keep input order) — until the sum reaches the floor or no
 * restorable drains remain (the sleeve may then still end below the floor; deposits, not
 * steering, must refill it). RETIRED/winddown sweeps are never restored. Adjusted
 * decisions get an 'R-FLOOR' note appended to reasons; their rule is unchanged.
 */
function applySleeveFloor(
  decisions: BandDecision[],
  markets: MarketObservation[],
  cfg: BandConfig,
  totalAssets: bigint,
): void {
  const floor = (totalAssets * BigInt(cfg.sleeveFloorBps)) / 10000n;
  const sum = decisions.reduce((acc, d) => acc + d.targetAmount, 0n);
  if (sum >= floor) return;

  const restorable = decisions
    .map((decision, i) => ({ decision, market: markets[i] }))
    .filter(({ decision, market }) =>
      market.mode === 'STEERED' && !decision.sweep && decision.targetAmount < market.vaultAssets)
    .sort((a, b) => {
      const drainA = a.market.vaultAssets - a.decision.targetAmount;
      const drainB = b.market.vaultAssets - b.decision.targetAmount;
      return drainB > drainA ? 1 : drainB < drainA ? -1 : 0; // largest drain first
    });

  let deficit = floor - sum;
  for (const { decision, market } of restorable) {
    if (deficit <= 0n) break;
    const drain = market.vaultAssets - decision.targetAmount;
    const restore = drain < deficit ? drain : deficit;
    decision.targetAmount += restore;
    deficit -= restore;
    decision.reasons.push(
      `R-FLOOR: restored ${fmtUsds(restore)} of drain to keep sleeve >= floor ${fmtUsds(floor)} ` +
      `(${cfg.sleeveFloorBps} bps of totalAssets ${fmtUsds(totalAssets)})`
    );
  }
}

/**
 * Compute one BandDecision per market observation (same order as the input array),
 * then apply the whole-vector sleeve-floor pass. Pure: same inputs -> same decisions.
 *
 * @param args.markets     per-market observations (fresh, accrued state)
 * @param args.cfg         validated band configuration (parseBandConfig output)
 * @param args.ssrApy      SSR as an APY fraction (computeSsrApy output, sanity-checked)
 * @param args.totalAssets vault totalAssets, 18-dec — the sleeve-floor base
 * @param args.nowSec      current UTC unix seconds
 */
export function computeBandDecisions(args: {
  markets: MarketObservation[];
  cfg: BandConfig;
  ssrApy: number;
  totalAssets: bigint;
  nowSec: number;
}): BandDecision[] {
  const { markets, cfg, ssrApy, totalAssets, nowSec } = args;
  const decisions = markets.map(m => decideMarket(m, cfg, ssrApy, nowSec));
  applySleeveFloor(decisions, markets, cfg, totalAssets);
  return decisions;
}
