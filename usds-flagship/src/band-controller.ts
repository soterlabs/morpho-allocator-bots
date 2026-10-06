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
 *   1. Priority deposit (PRIMARY): no rate target — the wish is "fill to
 *      effectiveCap", capped where the market's own utilization would drop under
 *      primaryMinUtilPercent (a deposit-only guard: a position already above that
 *      point holds), served by reconciliation before any other deposit. A PRIMARY
 *      market withdraws only through rule 0.
 *   2. Steering (STEERED): the market is held at the utilization u* where its
 *      CURRENT borrow rate equals the target rate SSR + margin — the number borrowers
 *      react to — found by inverting the Adaptive Curve IRM around the anchor
 *      (irm-curve.ts). [utilMinBps, utilMaxBps] bounds how far the bot itself pushes
 *      the market (a heating drain stops at utilMaxBps, a cooling deposit at
 *      utilMinBps); it is never a reason to push the other way, so a market that
 *      borrowers moved past a bound holds until the rate asks for a move back in.
 *      u* is inverted into an absolute vault target (targetSupply = ceil(borrow / u*)).
 *      A market whose rate already sits within RATE_REST_HALF_WIDTH_BPS of the target
 *      RESTs.
 *
 * Rules 1 and 2 size their wish through the same three steps, called in order:
 * boundTarget (the deposit ceiling), sizeGate (min action, direction cooldown),
 * clampToStepCaps. Steering adds the rate rest check, the clamp gate and the
 * utilization deadband before and the monopolist share after the shared gate.
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
import { borrowApyAtUtilization, utilizationBpsForBorrowApy } from './irm-curve.js';

const USDS_WAD = 10n ** 18n;
const SEC_PER_HOUR = 3_600;

/**
 * A steered market whose current borrow rate is within this many bps of its target
 * rests: the aim band is SSR + margin +- 10 bps (SSR + 50-70 bps at the default
 * margin). With a $10k minimum action moving a $3M market's rate by ~30 bps, finer
 * aim is not available anyway.
 */
const RATE_REST_HALF_WIDTH_BPS = 10;

/**
 * The IRM's target utilization: the only utilization at which the anchor stands
 * still. A target above it heats the market (the anchor drifts up while held there),
 * a target below it cools it.
 */
const IRM_TARGET_UTIL_BPS = 9000;

/**
 * Anchor reads above this are garbage: the Adaptive Curve IRM caps rateAtTarget at
 * 200% APR on-chain, which compounds to ~639% APY — 1000% is unreachable, so
 * anything beyond it is a corrupted read, not a hot market.
 */
const MAX_SANE_ANCHOR_APY = 10;

export interface MarketObservation {
  index: number; name: string; mode: MarketMode;
  // Per-market rate-margin override (bps). Falls back to cfg.rateMarginBps when unset.
  rateMarginBps?: number;
  totalSupplyAssets: bigint; totalBorrowAssets: bigint;  // accrued market totals
  vaultAssets: bigint;                                    // adapter position in this market
  anchorApy: number;                                      // rateAtTarget as APY, 0.0352 = 3.52%
  // Bands-mode cap from env (computeMarketCap). A position above it is a cap breach.
  // Undefined when the market has no env cap: then only the on-chain relative cap
  // bounds its deposits, and it never emits a priority withdrawal.
  marketCap?: bigint;
  // Deposit ceiling this cycle: min(on-chain relative cap, marketCap), each less the 1 bps headroom.
  effectiveCap: bigint;
  lastAllocateAtSec?: number; lastDeallocateAtSec?: number; // undefined = none in lookback window
}

/**
 * Where a steered market's target utilization sits relative to the IRM's 90% rest
 * point: HEAT (u* >= 90%: holding it there drifts the anchor up), COOL (u* < 90%:
 * the anchor drifts down), REST (the borrow rate is already on target, or the
 * utilization is inside the deadband of u*). A trace label: the action is the sign
 * of the delta, in every regime.
 */
export type Regime = 'HEAT' | 'REST' | 'COOL';

/** Machine-readable trace key for the decision a market ended on. */
export type BandRule =
  | 'R-HEAT' | 'R-REST' | 'R-COOL'
  | 'R-HOLD' | 'R-CLAMP' | 'R-DEADBAND' | 'R-MINACTION' | 'R-COOLDOWN' | 'R-SHARE' | 'R-RETIRED'
  | 'R-PRIORITY-DEPOSIT' | 'R-PRIORITY-WITHDRAWAL';

export interface BandDecision {
  index: number;
  targetAmount: bigint;      // absolute vault target for this market this cycle
  // Target utilization u* (bps) a steered market is held to; it doubles as the
  // market's maxUtilizationBps for the executor's withdrawal clamp. Undefined when
  // there is no rate target (PRIMARY, RETIRED, priority wishes).
  bandUtilBps?: number;
  targetRateApy?: number;    // SSR + margin the steered market is aimed at, 0.0412 = 4.12%
  regime?: Regime;           // steered markets only
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
function holdAt(m: MarketObservation, rule: BandRule, reasons: string[], steering?: SteeringTarget): BandDecision {
  return {
    index: m.index, targetAmount: m.vaultAssets, priority: false, rule, reasons,
    bandUtilBps: steering?.utilBps, targetRateApy: steering?.rateApy, regime: steering?.regime,
  };
}

/** The resolved rate target of a steered market, carried on every decision it makes. */
interface SteeringTarget {
  rateApy: number;   // SSR + margin
  utilBps: number;   // u*: the clamped utilization that prices the market at rateApy
  regime: Regime;
}

/** Market utilization as a WAD fraction (1e18 = 100%); an empty market reads as 0. */
function utilizationWad(totalSupplyAssets: bigint, totalBorrowAssets: bigint): bigint {
  if (totalSupplyAssets <= 0n) return 0n;
  return (totalBorrowAssets * USDS_WAD) / totalSupplyAssets;
}

/**
 * Target utilization u* for a steered market whose curve inverse (the utilization at
 * which the IRM prices it at the target rate) is `curveUtilBps`, bounded in the
 * direction the rate asks for: a heating drain (curve inverse above the current
 * utilization) stops at utilMaxBps, a cooling deposit at utilMinBps. The bound limits
 * how far the bot itself pushes the market — it is not a range the bot patrols, so a
 * move back toward the range lands on the exact curve inverse even when that is
 * outside it, and a market already past the bound in the asked-for direction is held
 * by clampGate. The bound is recorded in reasons; an unreachable target (above
 * 4 x anchor, below anchor / 4) saturates at the curve's end and so lands on it too.
 */
function targetUtilization(utilBps: number, curveUtilBps: number, cfg: BandConfig, reasons: string[]): number {
  if (curveUtilBps > utilBps && curveUtilBps > cfg.utilMaxBps) {
    reasons.push(`curve inverse ${curveUtilBps} bps clamped down to UTIL_MAX ${cfg.utilMaxBps} bps`);
    return cfg.utilMaxBps;
  }
  if (curveUtilBps < utilBps && curveUtilBps < cfg.utilMinBps) {
    reasons.push(`curve inverse ${curveUtilBps} bps clamped up to UTIL_MIN ${cfg.utilMinBps} bps`);
    return cfg.utilMinBps;
  }
  return curveUtilBps;
}

/**
 * Steering gate: the bound blocks the only useful direction -> R-CLAMP. A market at or
 * past UTIL_MAX whose rate is under the target would need an even hotter utilization;
 * one at or past UTIL_MIN whose rate is over it would need a colder one. Pushing it
 * back into the range would move the rate AWAY from the target (and spend sleeve
 * budget doing so), so the bot holds and leaves the move to the anchor drift, which
 * works in the right direction on both sides of 90% — the faster the further out.
 */
function clampGate(utilBps: number, curveUtilBps: number, targetUtilBps: number, cfg: BandConfig): Hold | undefined {
  if (curveUtilBps > utilBps && targetUtilBps <= utilBps) {
    return {
      rule: 'R-CLAMP',
      why: `util ${utilBps} bps already at/above UTIL_MAX ${cfg.utilMaxBps} bps and the rate wants it higher ` +
        `(curve inverse ${curveUtilBps} bps) -> hold, the anchor heats on its own above 90%`,
    };
  }
  if (curveUtilBps < utilBps && targetUtilBps >= utilBps) {
    return {
      rule: 'R-CLAMP',
      why: `util ${utilBps} bps already at/below UTIL_MIN ${cfg.utilMinBps} bps and the rate wants it lower ` +
        `(curve inverse ${curveUtilBps} bps) -> hold, the anchor cools on its own below 90%`,
    };
  }
  return undefined;
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

/** Steering gate: |utilBps - u*| <= deadband (inclusive) -> R-DEADBAND. */
function deadbandGate(utilBps: number, targetUtilBps: number, cfg: BandConfig): Hold | undefined {
  if (Math.abs(utilBps - targetUtilBps) > cfg.utilDeadbandBps) return undefined;
  return {
    rule: 'R-DEADBAND',
    why: `|util ${utilBps} - target util ${targetUtilBps}| <= deadband ${cfg.utilDeadbandBps} bps -> hold`,
  };
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
    return holdAt(m, 'R-PRIORITY-WITHDRAWAL', [...reasons,
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
 * asks for the whole gap up to its fill target, with no rate input — the anchor plays
 * no role. The fill target is the smaller of the deposit ceiling and the utilization
 * floor: the vault position at which the market's utilization would be exactly
 * primaryMinUtilPercent (supply = borrow / floor, floored so the fill never lands
 * under it). The floor makes the fill track the market's own borrow demand instead of
 * absorbing every dollar other markets free. It is a deposit-time guard only: at or
 * above the fill target the market holds (draining back to the cap is the
 * priority-withdrawal rule's job); otherwise the gap is sized by the shared steps.
 */
function decidePriorityDeposit(m: MarketObservation, cfg: BandConfig, nowSec: number): BandDecision {
  const reasons: string[] = [];
  const floorSupplyTotal = (m.totalBorrowAssets * 100n) / BigInt(cfg.primaryMinUtilPercent);
  const vaultAtFloor = m.vaultAssets + floorSupplyTotal - m.totalSupplyAssets;
  const floorBinds = vaultAtFloor < m.effectiveCap;
  const fillTarget = boundTarget(m, floorBinds ? vaultAtFloor : m.effectiveCap, reasons);
  const delta = fillTarget - m.vaultAssets;
  reasons.unshift(
    `mode=PRIMARY: fill to min(effectiveCap ${fmtUsds(m.effectiveCap)}, ` +
    `util floor ${fmtUsds(vaultAtFloor < 0n ? 0n : vaultAtFloor)} = position at ${cfg.primaryMinUtilPercent}% util ` +
    `on borrow ${fmtUsds(m.totalBorrowAssets)}) from ${fmtUsds(m.vaultAssets)} (delta ${fmtSignedUsds(delta)})`
  );
  if (delta <= 0n) {
    return holdAt(m, 'R-HOLD', [...reasons,
      `at/above ${floorBinds ? `the ${cfg.primaryMinUtilPercent}% util floor` : 'effectiveCap'} -> hold`]);
  }
  const gate = sizeGate(m, cfg, nowSec, delta);
  if (gate) return holdAt(m, gate.rule, [...reasons, gate.why]);
  const step = clampToStepCaps(cfg, delta, reasons);
  return {
    index: m.index, targetAmount: m.vaultAssets + step, bandUtilBps: undefined,
    priority: true, rule: 'R-PRIORITY-DEPOSIT', reasons,
  };
}

/**
 * Steering (STEERED): aim the market's borrow rate at SSR + margin. The target
 * utilization u* is the curve inverse of that rate around the anchor, bounded in the
 * asked-for direction (targetUtilization); a market whose current rate is already
 * within RATE_REST_HALF_WIDTH_BPS of the target RESTs with no action. Otherwise u*
 * is inverted into an absolute vault target and the wish is sized through the shared
 * steps, with the three steering-only gates around the shared one (each hold carries
 * its own rule): rest -> clamp -> deadband -> min action -> cooldown -> share -> step caps.
 */
function decideSteered(m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number): BandDecision {
  if (!Number.isFinite(m.anchorApy) || m.anchorApy <= 0 || m.anchorApy > MAX_SANE_ANCHOR_APY) {
    // The whole target keys off the anchor, so a corrupted rateAtTarget read would
    // steer real funds off garbage. Zero is included: the IRM floors rateAtTarget at
    // 0.1% APR on-chain, so 0 can only be a failed read. Abort the cycle instead.
    throw new Error(
      `${m.name}: anchor APY ${m.anchorApy} is outside (0, ${MAX_SANE_ANCHOR_APY}] — ` +
      `refusing to steer off a suspect read`
    );
  }
  const marginBps = m.rateMarginBps ?? cfg.rateMarginBps;
  const rateApy = ssrApy + marginBps / 10000;
  const reasons: string[] = [];
  const utilBps = utilizationBps(m.totalSupplyAssets, m.totalBorrowAssets);
  const borrowApyNow = borrowApyAtUtilization(m.anchorApy, utilizationWad(m.totalSupplyAssets, m.totalBorrowAssets));
  const deviationBps = Math.round((borrowApyNow - rateApy) * 10000);
  const curveUtilBps = utilizationBpsForBorrowApy(rateApy, m.anchorApy);
  const targetUtilBps = targetUtilization(utilBps, curveUtilBps, cfg, reasons);
  reasons.unshift(
    `target rate ${fmtPct(rateApy)} = SSR ${fmtPct(ssrApy)} + ${marginBps} bps` +
    `${m.rateMarginBps !== undefined ? ' (per-market override)' : ''}; ` +
    `anchor ${fmtPct(m.anchorApy)}, util ${utilBps} bps -> borrow ${fmtPct(borrowApyNow)} ` +
    `(${deviationBps >= 0 ? '+' : ''}${deviationBps} bps off target)`
  );

  if (Math.abs(deviationBps) <= RATE_REST_HALF_WIDTH_BPS) {
    return holdAt(m, 'R-REST', [...reasons,
      `borrow rate within +-${RATE_REST_HALF_WIDTH_BPS} bps of target -> rest`],
      { rateApy, utilBps: targetUtilBps, regime: 'REST' });
  }
  const regime: Regime = targetUtilBps >= IRM_TARGET_UTIL_BPS ? 'HEAT' : 'COOL';
  const steering: SteeringTarget = { rateApy, utilBps: targetUtilBps, regime };
  const clamp = clampGate(utilBps, curveUtilBps, targetUtilBps, cfg);
  if (clamp) return holdAt(m, clamp.rule, [...reasons, clamp.why], steering);

  // Invert u* into an absolute vault target; ceil keeps the resulting utilization
  // from rounding ABOVE the target.
  const targetSupplyTotal = ceilDiv(m.totalBorrowAssets * 10000n, BigInt(targetUtilBps));
  const targetVault = boundTarget(m, m.vaultAssets + targetSupplyTotal - m.totalSupplyAssets, reasons);
  const delta = targetVault - m.vaultAssets;
  reasons.push(
    `target util ${targetUtilBps} bps (${regime}) -> vault target ${fmtUsds(targetVault)} (delta ${fmtSignedUsds(delta)})`
  );

  const deadband = deadbandGate(utilBps, targetUtilBps, cfg);
  if (deadband) return holdAt(m, deadband.rule, [...reasons, deadband.why], { ...steering, regime: 'REST' });
  const gate = sizeGate(m, cfg, nowSec, delta) ?? shareGate(m, cfg, delta);
  if (gate) return holdAt(m, gate.rule, [...reasons, gate.why], steering);
  const step = clampToStepCaps(cfg, delta, reasons);
  return {
    index: m.index, targetAmount: m.vaultAssets + step, priority: false, rule: `R-${regime}`, reasons,
    bandUtilBps: targetUtilBps, targetRateApy: rateApy, regime,
  };
}

/** Single-market decision by mode, with the priority-withdrawal rule ahead of any steering. */
function decideMarket(
  m: MarketObservation, cfg: BandConfig, ssrApy: number, nowSec: number, liquidityReservePercent: bigint,
): BandDecision {
  if (m.mode === 'RETIRED') {
    return holdAt(m, 'R-RETIRED',
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
