import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { AdaptiveCurveIrmLib, Market, MarketParams } from '@morpho-org/blue-sdk';
import { simulateAnchor, anchorPerSecWadToApy, apyFraction, postTradeUtilizationWad, type UtilSegment } from './anchor-sim.js';

const eth = parseEther;
const WAD = 1_000_000_000_000_000_000n;
const DAY = 86_400n;
const TS = 1_800_000_000n; // fixed timestamp for determinism

// INITIAL_RATE_AT_TARGET = 4% APR per-second — a realistic mid-range anchor,
// far from both clamps, so drift tests measure adaptation and not saturation.
const R0 = AdaptiveCurveIrmLib.INITIAL_RATE_AT_TARGET;

const seg = (utilizationWad: bigint, durationSec: bigint): UtilSegment => ({ utilizationWad, durationSec });

describe('simulateAnchor', () => {
  it('drift direction: 100% util raises the anchor, 0% lowers it, 90% (target) leaves it unchanged', () => {
    expect(simulateAnchor(R0, [seg(WAD, DAY)])).toBeGreaterThan(R0);
    expect(simulateAnchor(R0, [seg(0n, DAY)])).toBeLessThan(R0);
    // err = 0 at target => linearAdaptation = 0 => the contract keeps the rate
    // bit-for-bit unchanged, so this is exact equality, not approximate.
    expect(simulateAnchor(R0, [seg(AdaptiveCurveIrmLib.TARGET_UTILIZATION, DAY)])).toBe(R0);
  });

  it('doubles in ~5 days at full positive error (util = 100%)', () => {
    // ADJUSTMENT_SPEED = 50/year, so at err = +1 the anchor grows as
    // exp(50 * t/year): doubling time ln2/50 years ~= 5.06 days. After exactly
    // 5 days the ratio is exp(50 * 5/365) ~= 1.9836 — within 5% of 2.
    const end = simulateAnchor(R0, [seg(WAD, 5n * DAY)]);
    const ratio = Number(end) / Number(R0);
    expect(ratio).toBeGreaterThan(2 * 0.95);
    expect(ratio).toBeLessThan(2 * 1.05);
  });

  it('clamps at MIN_RATE_AT_TARGET and MAX_RATE_AT_TARGET', () => {
    const { MIN_RATE_AT_TARGET, MAX_RATE_AT_TARGET } = AdaptiveCurveIrmLib;
    // A year at full error moves the anchor by e^±50 — astronomically past
    // either bound — so the clamp value is hit exactly.
    expect(simulateAnchor(R0, [seg(0n, 365n * DAY)])).toBe(MIN_RATE_AT_TARGET);
    expect(simulateAnchor(R0, [seg(WAD, 365n * DAY)])).toBe(MAX_RATE_AT_TARGET);
    // Already pinned at a bound and still pushing: stays exactly at the bound.
    expect(simulateAnchor(MIN_RATE_AT_TARGET, [seg(0n, 365n * DAY)])).toBe(MIN_RATE_AT_TARGET);
    expect(simulateAnchor(MAX_RATE_AT_TARGET, [seg(WAD, 365n * DAY)])).toBe(MAX_RATE_AT_TARGET);
  });

  it('is segmentation-sensitive: 1x7d and 7x1d at constant util differ (why segments are explicit)', () => {
    // wExp is a chunked 2nd-order Taylor approximation and every step rounds
    // down through wMulDown, so folding 7 daily accruals is NOT the same as
    // one weekly accrual — matching how on-chain accrual cadence perturbs the
    // real anchor. This is the documented reason simulateAnchor never merges
    // or splits caller segments.
    const oneWeekly = simulateAnchor(R0, [seg(WAD, 7n * DAY)]);
    const sevenDaily = simulateAnchor(R0, Array.from({ length: 7 }, () => seg(WAD, DAY)));
    expect(sevenDaily).not.toBe(oneWeekly);
    // The drift is real but small (~1e-4 relative over a week at full error):
    // segmentation choice matters at wei precision, not at decision precision.
    const relDiff = Math.abs(Number(oneWeekly - sevenDaily)) / Number(oneWeekly);
    expect(relDiff).toBeGreaterThan(0);
    expect(relDiff).toBeLessThan(1e-3);
  });

  it('cross-checks against the SDK Market accrual path (same construction as optimizer-logic toSdkMarket)', () => {
    const supply = eth('1000');
    const borrow = eth('950'); // util 95% => positive error, anchor drifts up
    const market = new Market({
      params: new MarketParams({
        loanToken: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
        collateralToken: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9',
        oracle: '0x0A976226d113B67Bd42D672Ac9f83f92B44b454C',
        irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
        lltv: 860000000000000000n,
      }),
      totalSupplyAssets: supply,
      totalSupplyShares: supply * 1_000_000n,
      totalBorrowAssets: borrow,
      totalBorrowShares: borrow * 1_000_000n,
      lastUpdate: TS,
      fee: 0n,
      rateAtTarget: R0,
    });
    // Market.accrueInterest holds the START utilization fixed for the whole
    // elapsed window (one on-chain accrual), which is exactly one segment at
    // market.utilization — so the two paths agree bit-for-bit.
    const accrued = market.accrueInterest(TS + 3n * DAY);
    const simulated = simulateAnchor(R0, [seg(market.utilization, 3n * DAY)]);
    expect(accrued.rateAtTarget).toBe(simulated);
  });

  it('empty segment list and zero-duration segments are the identity', () => {
    expect(simulateAnchor(R0, [])).toBe(R0);
    expect(simulateAnchor(R0, [seg(WAD, 0n)])).toBe(R0);
  });

  it('fails loud on invalid inputs instead of inheriting SDK fallbacks', () => {
    // Zero anchor would silently become INITIAL_RATE_AT_TARGET inside the SDK
    // ("first interaction") — masking a bad on-chain read. Must throw.
    expect(() => simulateAnchor(0n, [seg(WAD, DAY)])).toThrow(/anchorStartPerSecWad/);
    expect(() => simulateAnchor(-1n, [seg(WAD, DAY)])).toThrow(/anchorStartPerSecWad/);
    expect(() => simulateAnchor(R0, [seg(WAD + 1n, DAY)])).toThrow(/utilizationWad/);
    expect(() => simulateAnchor(R0, [seg(-1n, DAY)])).toThrow(/utilizationWad/);
    expect(() => simulateAnchor(R0, [seg(WAD, -1n)])).toThrow(/durationSec/);
  });
});

describe('postTradeUtilizationWad (log-only A/B bracket input)', () => {
  it('regression: a sweep drain exceeding idle liquidity clamps to 100% and never aborts the bracket', () => {
    // stUSDS-like RETIRED sweep: 14M supply, 13.2M borrow, vault position 10M, target 0.
    // Raw post-trade util = 13.2M / 4M = 3.3e18 — out of simulateAnchor's domain. The
    // real withdraw is liquidity-capped, so 100% is the truthful projection; the
    // diagnostics-only bracket must project WAD instead of throwing.
    const postSupply = eth('14000000') - eth('10000000'); // 4M < 13.2M borrow
    const util = postTradeUtilizationWad(postSupply, eth('13200000'));
    expect(util).toBe(WAD);
    expect(() => simulateAnchor(R0, [seg(util, DAY)])).not.toThrow();
  });

  it('projects 100% when the vault IS the whole supply (postSupply 0 with borrow outstanding)', () => {
    // A PT-sUSDS T-14 winddown with util pinned at 100%: sweeping the whole position
    // projects an empty supply while borrow remains — the truthful projection is 100%,
    // not the 0% a naive "postSupply <= 0 -> 0" branch would report.
    expect(postTradeUtilizationWad(0n, eth('710000'))).toBe(WAD);
    expect(postTradeUtilizationWad(-1n, eth('710000'))).toBe(WAD);
  });

  it('projects 0% only for a genuinely empty market', () => {
    expect(postTradeUtilizationWad(0n, 0n)).toBe(0n);
    expect(postTradeUtilizationWad(eth('1000'), 0n)).toBe(0n);
  });

  it('is the plain utilization division when liquidity suffices', () => {
    expect(postTradeUtilizationWad(eth('1000'), eth('900'))).toBe((eth('900') * WAD) / eth('1000'));
    expect(postTradeUtilizationWad(eth('1000'), eth('1000'))).toBe(WAD); // exactly 100% is in-domain
  });
});

describe('anchorPerSecWadToApy / apyFraction', () => {
  it('converts the initial anchor (4% APR per-second) to ~4.08% APY', () => {
    // Continuous compounding: expm1(0.04) ~= 0.040811. R0 is 0.04e18 / SECONDS_PER_YEAR
    // floored, so allow wei-truncation slack.
    expect(anchorPerSecWadToApy(R0)).toBeCloseTo(Math.expm1(0.04), 6);
  });

  it('bigint and float paths agree on the same rate', () => {
    const end = simulateAnchor(R0, [seg(WAD, 5n * DAY)]);
    expect(apyFraction(Number(end) / 1e18)).toBeCloseTo(anchorPerSecWadToApy(end), 12);
  });

  it('zero rate is zero APY', () => {
    expect(anchorPerSecWadToApy(0n)).toBe(0);
    expect(apyFraction(0)).toBe(0);
  });
});
