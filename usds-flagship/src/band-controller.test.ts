import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { parseBandConfig, type BandConfig } from './band-config.js';
import { computeBandDecisions, type BandDecision, type MarketObservation } from './band-controller.js';

const eth = parseEther;
const DAY = 86_400;
const HOUR = 3_600;

// Fixture clock: 2026-07-30T00:00:00Z. All timestamps UTC unix seconds.
const NOW = 1_785_369_600;
// SSR on 2026-07-30: 3.52% APY. Derived thresholds (defaults):
//   SSR_t = 3.67%, low = 4/7 x SSR = 2.0114%, high = 8/7 x SSR = 4.0229%.
const SSR = 0.0352;
// PT-sUSDS maturity: 2026-11-26T00:00:00Z.
const PT_MATURITY = 1_795_651_200;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function cfg(overrides: Record<string, string | undefined> = {}): BandConfig {
  return parseBandConfig({ MAX_ALLOCATE_USDS: '5000000', MAX_DEALLOCATE_USDS: '5000000', ...overrides });
}

// Realistic 2026-07-30 fixtures.
// cbBTC/USDS: 3.81M supply, 3.45M borrow (util 9055), anchor 2.30%, supplyApy 2.47%.
// Vault holds 3.6M (share 9448 — monopolist).
function cbBtc(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    index: 0, name: 'cbBTC/USDS', mode: 'STEERED',
    totalSupplyAssets: eth('3810000'), totalBorrowAssets: eth('3450000'),
    vaultAssets: eth('3600000'),
    supplyApy: 0.0247, anchorApy: 0.0230,
    effectiveCap: eth('100000000'),
    ...overrides,
  };
}

// wstETH/USDS: 2.58M supply, 2.33M borrow (util 9031), anchor 3.39%, supplyApy 3.26%.
function wstEth(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    index: 1, name: 'wstETH/USDS', mode: 'STEERED',
    totalSupplyAssets: eth('2580000'), totalBorrowAssets: eth('2330000'),
    vaultAssets: eth('2400000'),
    supplyApy: 0.0326, anchorApy: 0.0339,
    effectiveCap: eth('100000000'),
    ...overrides,
  };
}

// PT-sUSDS/USDS: 0.71M supply = borrow (util 10000 — pinned), anchor 0.45%, SOUNDING.
function ptSusds(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    index: 2, name: 'PT-sUSDS/USDS', mode: 'SOUNDING', maturityUtcSec: PT_MATURITY,
    totalSupplyAssets: eth('710000'), totalBorrowAssets: eth('710000'),
    vaultAssets: eth('710000'),
    supplyApy: 0.018, anchorApy: 0.0045,
    effectiveCap: eth('10000000'),
    ...overrides,
  };
}

// Single-market decide helper. Default totalAssets is deliberately tiny (floor = 120
// USDS) so the sleeve-floor pass is inert in single-market tests; the floor tests pass
// totalAssets explicitly.
function decide(
  m: MarketObservation,
  c: BandConfig = cfg(),
  opts: { ssrApy?: number; totalAssets?: bigint; nowSec?: number } = {},
): BandDecision {
  return computeBandDecisions({
    markets: [m],
    cfg: c,
    ssrApy: opts.ssrApy ?? SSR,
    totalAssets: opts.totalAssets ?? eth('1000'),
    nowSec: opts.nowSec ?? NOW,
  })[0];
}

// Expected STEERED vault target (unclamped, ungated) for a band: the exact inversion.
function invertedTarget(m: MarketObservation, bandUtilBps: number): bigint {
  return m.vaultAssets + ceilDiv(m.totalBorrowAssets * 10000n, BigInt(bandUtilBps)) - m.totalSupplyAssets;
}

describe('band classification (STEERED)', () => {
  it('R-HARV: satApy = 0.9 x anchor >= SSR_t holds the harvest band 9000', () => {
    // anchor 4.5% -> satApy 4.05% >= SSR_t 3.67%. util 8500, drain toward 9000.
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('850000'),
      vaultAssets: eth('900000'), anchorApy: 0.045,
    });
    const d = decide(m);
    expect(d.rule).toBe('R-HARV');
    expect(d.bandUtilBps).toBe(9000);
    expect(d.sweep).toBe(false);
    expect(d.targetAmount).toBe(invertedTarget(m, 9000));
    expect(d.targetAmount).toBeLessThan(m.vaultAssets); // drain: 8500 -> 9000
  });

  it('R-DRAIN94: supplyApy below 4/7 x SSR (2.011%) drains to band 9400', () => {
    const m = cbBtc({
      totalSupplyAssets: eth('2000000'), totalBorrowAssets: eth('1000000'),
      vaultAssets: eth('1900000'), supplyApy: 0.01, anchorApy: 0.02,
    });
    const d = decide(m);
    expect(d.rule).toBe('R-DRAIN94');
    expect(d.bandUtilBps).toBe(9400);
    expect(d.targetAmount).toBe(invertedTarget(m, 9400));
  });

  it('R-HIGH92: supplyApy above 8/7 x SSR (4.023%) grows toward band 9200', () => {
    // satApy = 0.9 x 4.0% = 3.60% < SSR_t 3.67%, so not harvest. util 9700 -> grow.
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('970000'),
      vaultAssets: eth('500000'), supplyApy: 0.045, anchorApy: 0.04,
    });
    const d = decide(m);
    expect(d.rule).toBe('R-HIGH92');
    expect(d.bandUtilBps).toBe(9200);
    expect(d.targetAmount).toBe(invertedTarget(m, 9200));
    expect(d.targetAmount).toBeGreaterThan(m.vaultAssets); // grow: 9700 -> 9200
  });

  it('R-MID93: cbBTC 2026-07-30 fixture (supplyApy 2.47% between thresholds) drains to 9300', () => {
    const m = cbBtc();
    const d = decide(m);
    expect(d.rule).toBe('R-MID93');
    expect(d.bandUtilBps).toBe(9300);
    // Drain of ~100,322.58 USDS: 3.81M supply -> ceil(3.45M / 93%).
    expect(d.targetAmount).toBe(invertedTarget(m, 9300));
    expect(d.targetAmount).toBe(m.vaultAssets - 100322580645161290322580n);
  });

  it('R-MID93: wstETH 2026-07-30 fixture (supplyApy 3.26%) drains ~74.6k to 9300', () => {
    const m = wstEth();
    const d = decide(m);
    expect(d.rule).toBe('R-MID93');
    expect(d.bandUtilBps).toBe(9300);
    expect(d.targetAmount).toBe(invertedTarget(m, 9300));
    expect(m.vaultAssets - d.targetAmount).toBe(74623655913978494623655n); // ~74,623.66 USDS
  });

  it('includes resolved absolute thresholds in reasons', () => {
    const d = decide(cbBtc());
    const trace = d.reasons.join(' | ');
    expect(trace).toContain('2.011%');  // 4/7 x SSR resolved
    expect(trace).toContain('4.023%');  // 8/7 x SSR resolved
    expect(trace).toContain('2.470%');  // the market's supplyApy
  });
});

describe('per-market SSR_t margin override', () => {
  // anchor 4.15% -> satApy 3.735%: above the global SSR_t 3.67% but below SSR + 50 bps
  // (4.02%). util 8500 so the harvest case is a clean drain toward 9000.
  const nearHurdle = () => cbBtc({
    totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('850000'),
    vaultAssets: eth('900000'), anchorApy: 0.0415, supplyApy: 0.035,
  });

  it('falls back to the global margin when unset (harvest at satApy 3.735% >= 3.67%)', () => {
    const d = decide(nearHurdle());
    expect(d.rule).toBe('R-HARV');
    expect(d.reasons.join(' | ')).not.toContain('per-market override');
  });

  it('a higher per-market margin raises the hurdle (50 bps -> the same market is mid band)', () => {
    const d = decide({ ...nearHurdle(), ssrTMarginBps: 50 });
    expect(d.rule).toBe('R-MID93');
    expect(d.bandUtilBps).toBe(9300);
  });

  it('a lower per-market margin lowers the hurdle (anchor 4.0%, satApy 3.60% harvests at +5 bps)', () => {
    // Global margin 15 bps: satApy 3.60% < 3.67% -> not harvest. Override 5 bps: 3.60% >= 3.57%.
    const base = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('850000'),
      vaultAssets: eth('900000'), anchorApy: 0.04, supplyApy: 0.035,
    });
    expect(decide(base).rule).toBe('R-MID93');
    const d = decide({ ...base, ssrTMarginBps: 5 });
    expect(d.rule).toBe('R-HARV');
    expect(d.reasons.join(' | ')).toContain('per-market override');
  });
});

describe('ceil inversion exactness', () => {
  // The inverted supply target S* = ceil(borrow * 10000 / band) is exact: at S* the
  // (floored) utilization is <= band, and at S* - 1 wei the true utilization strictly
  // exceeds the band.
  function assertInversionExact(m: MarketObservation, d: BandDecision): void {
    const band = BigInt(d.bandUtilBps!);
    const newSupply = m.totalSupplyAssets + (d.targetAmount - m.vaultAssets);
    expect((m.totalBorrowAssets * 10000n) / newSupply <= band).toBe(true);
    expect(m.totalBorrowAssets * 10000n <= newSupply * band).toBe(true);          // util(S*) <= band exactly
    expect(m.totalBorrowAssets * 10000n > (newSupply - 1n) * band).toBe(true);    // util(S* - 1) > band exactly
  }

  it('holds for the cbBTC drain (band 9300)', () => {
    const m = cbBtc();
    assertInversionExact(m, decide(m));
  });

  it('holds for the wstETH drain (band 9300)', () => {
    const m = wstEth();
    assertInversionExact(m, decide(m));
  });

  it('holds for a grow (band 9200)', () => {
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('970000'),
      vaultAssets: eth('500000'), supplyApy: 0.045, anchorApy: 0.04,
    });
    assertInversionExact(m, decide(m));
  });

  it('holds for a harvest drain (band 9000)', () => {
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('850000'),
      vaultAssets: eth('900000'), anchorApy: 0.045,
    });
    assertInversionExact(m, decide(m));
  });
});

describe('gates (STEERED)', () => {
  it('R-DEADBAND: |util - band| <= 50 bps holds, even when the inverted delta is large', () => {
    // util 9250, band 9300 -> diff exactly 50 (inclusive edge). The inverted delta is
    // ~-537k on this 100M market, so only the deadband explains the hold — proves the
    // deadband gate runs before min-action.
    const m = cbBtc({
      totalSupplyAssets: eth('100000000'), totalBorrowAssets: eth('92500000'),
      vaultAssets: eth('90000000'),
    });
    const d = decide(m);
    expect(d.rule).toBe('R-DEADBAND');
    expect(d.targetAmount).toBe(m.vaultAssets);
    expect(d.bandUtilBps).toBe(9300);
  });

  it('does not deadband at 51+ bps from the band', () => {
    const d = decide(cbBtc()); // util 9055, band 9300 -> 245 bps away
    expect(d.rule).toBe('R-MID93');
  });

  it('R-MINACTION: |delta| below $30k holds', () => {
    // util 9000, band 9300 (out of deadband), inverted drain only ~9,677 USDS.
    const m = cbBtc({
      totalSupplyAssets: eth('300000'), totalBorrowAssets: eth('270000'),
      vaultAssets: eth('290000'),
    });
    const d = decide(m);
    expect(d.rule).toBe('R-MINACTION');
    expect(d.targetAmount).toBe(m.vaultAssets);
  });

  it('R-COOLDOWN: a grow within 24h of the last deallocate holds', () => {
    // util 9600, band 9300 -> grow of ~32,258 USDS, blocked by a 1h-old deallocate.
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('960000'),
      vaultAssets: eth('500000'), lastDeallocateAtSec: NOW - HOUR,
    });
    const d = decide(m);
    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.targetAmount).toBe(m.vaultAssets);
  });

  it('allows the grow once the direction cooldown has fully elapsed (exactly 24h)', () => {
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('960000'),
      vaultAssets: eth('500000'), lastDeallocateAtSec: NOW - 24 * HOUR,
    });
    const d = decide(m);
    expect(d.rule).toBe('R-MID93');
    expect(d.targetAmount).toBe(invertedTarget(m, 9300));
  });

  it('a recent ALLOCATE does not block a grow (same-direction actions are free)', () => {
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('960000'),
      vaultAssets: eth('500000'), lastAllocateAtSec: NOW - HOUR,
    });
    expect(decide(m).rule).toBe('R-MID93');
  });

  it('R-COOLDOWN: a drain within 24h of the last allocate holds', () => {
    const m = cbBtc({ lastAllocateAtSec: NOW - HOUR });
    const d = decide(m);
    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.targetAmount).toBe(m.vaultAssets);
  });

  it('allows the drain once the direction cooldown has fully elapsed', () => {
    const m = cbBtc({ lastAllocateAtSec: NOW - 24 * HOUR });
    expect(decide(m).rule).toBe('R-MID93');
  });

  it('R-SHARE: a drain while vault share < 80% holds (draining cannot move util)', () => {
    // vault 1M of 3.81M supply = share 2624 bps < 8000.
    const m = cbBtc({ vaultAssets: eth('1000000') });
    const d = decide(m);
    expect(d.rule).toBe('R-SHARE');
    expect(d.targetAmount).toBe(m.vaultAssets);
  });

  it('grows are still allowed at low vault share', () => {
    // grow market with share 5000 — R-SHARE is drain-only.
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('960000'),
      vaultAssets: eth('500000'),
    });
    const d = decide(m);
    expect(d.rule).toBe('R-MID93');
    expect(d.targetAmount).toBeGreaterThan(m.vaultAssets);
  });
});

describe('step caps', () => {
  it('clamps a drain to MAX_DEALLOCATE_USDS, rule unchanged', () => {
    // cbBTC wants to drain ~100,322 USDS; cap at 50k.
    const m = cbBtc();
    const d = decide(m, cfg({ MAX_DEALLOCATE_USDS: '50000' }));
    expect(d.rule).toBe('R-MID93');
    expect(d.targetAmount).toBe(m.vaultAssets - eth('50000'));
    expect(d.reasons.join(' | ')).toContain('MAX_DEALLOCATE');
  });

  it('clamps a grow to MAX_ALLOCATE_USDS, rule unchanged', () => {
    // grow of ~32,258 USDS clamped to 10k (min-action is judged on the UNCLAMPED delta,
    // so the clamped amount may legitimately land below $30k).
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('960000'),
      vaultAssets: eth('500000'),
    });
    const d = decide(m, cfg({ MAX_ALLOCATE_USDS: '10000' }));
    expect(d.rule).toBe('R-MID93');
    expect(d.targetAmount).toBe(m.vaultAssets + eth('10000'));
    expect(d.reasons.join(' | ')).toContain('MAX_ALLOCATE');
  });
});

describe('SOUNDING (PT-sUSDS)', () => {
  it('R-SND-FEED: first feed tops the position UP TO the $3M first tranche', () => {
    // Pinned at util 10000 >= stick 9500, no prior feed: 0.71M -> 3M (+2.29M).
    const d = decide(ptSusds());
    expect(d.rule).toBe('R-SND-FEED');
    expect(d.targetAmount).toBe(eth('3000000'));
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.sweep).toBe(false);
  });

  it('R-SND-FEED: at/above the first tranche it feeds the $1.5M follow-up', () => {
    const m = ptSusds({
      totalSupplyAssets: eth('3100000'), totalBorrowAssets: eth('3000000'), // util 9677
      vaultAssets: eth('3000000'),
    });
    const d = decide(m);
    expect(d.rule).toBe('R-SND-FEED');
    expect(d.targetAmount).toBe(eth('4500000'));
  });

  it('feeds at exactly the stick gate (util 9500 inclusive)', () => {
    const m = ptSusds({ totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('950000'), vaultAssets: eth('710000') });
    const d = decide(m);
    expect(d.rule).toBe('R-SND-FEED');
    expect(d.targetAmount).toBe(eth('3000000'));
  });

  it('R-SND-HOLD: below the stick gate demand is not sticking — hold, never drain', () => {
    // util 9492 < 9500.
    const m = ptSusds({ totalBorrowAssets: eth('674000') });
    const d = decide(m);
    expect(d.rule).toBe('R-SND-HOLD');
    expect(d.targetAmount).toBe(m.vaultAssets);
    expect(d.bandUtilBps).toBeUndefined();
  });

  it('R-SND-HOLD: a feed within the 24h feed cooldown holds', () => {
    const d = decide(ptSusds({ lastAllocateAtSec: NOW - 23 * HOUR }));
    expect(d.rule).toBe('R-SND-HOLD');
    expect(d.targetAmount).toBe(eth('710000'));
  });

  it('feeds again once the feed cooldown has fully elapsed (exactly 24h)', () => {
    const d = decide(ptSusds({ lastAllocateAtSec: NOW - 24 * HOUR }));
    expect(d.rule).toBe('R-SND-FEED');
    expect(d.targetAmount).toBe(eth('3000000'));
  });

  it('clamps the tranche to MAX_ALLOCATE_USDS', () => {
    // First tranche wants +2.29M; step cap 1M -> target 1.71M.
    const d = decide(ptSusds(), cfg({ MAX_ALLOCATE_USDS: '1000000' }));
    expect(d.rule).toBe('R-SND-FEED');
    expect(d.targetAmount).toBe(eth('1710000'));
  });

  it('clamps the target to effectiveCap', () => {
    const d = decide(ptSusds({ effectiveCap: eth('2000000') }));
    expect(d.rule).toBe('R-SND-FEED');
    expect(d.targetAmount).toBe(eth('2000000'));
  });

  it('never drains, even when effectiveCap has dropped below the current position', () => {
    const m = ptSusds({ effectiveCap: eth('500000') });
    const d = decide(m);
    // The clamp reduced the feed to zero movement, so the machine-readable rule is a
    // HOLD (no phantom R-SND-FEED in trace aggregation); reasons explain the cap clamp.
    expect(d.rule).toBe('R-SND-HOLD');
    expect(d.targetAmount).toBe(m.vaultAssets); // held, not drained to the cap
    expect(d.reasons.join(' | ')).toContain('SOUNDING never drains');
  });

  it('reports R-SND-HOLD when effectiveCap sits exactly at the current position', () => {
    const m = ptSusds({ effectiveCap: eth('710000') }); // == vaultAssets
    const d = decide(m);
    expect(d.rule).toBe('R-SND-HOLD');
    expect(d.targetAmount).toBe(m.vaultAssets);
  });
});

describe('winddown overlay (PT maturity 2026-11-26T00:00:00Z)', () => {
  const T30 = PT_MATURITY - 30 * DAY;
  const T14 = PT_MATURITY - 14 * DAY;

  it('R-WD30: from exactly T-30d a would-be SOUNDING feed becomes a hold', () => {
    const m = ptSusds();
    const d = decide(m, cfg(), { nowSec: T30 });
    expect(d.rule).toBe('R-WD30');
    expect(d.targetAmount).toBe(m.vaultAssets);
    expect(d.sweep).toBe(false);
  });

  it('still feeds one second before T-30d', () => {
    const d = decide(ptSusds(), cfg(), { nowSec: T30 - 1 });
    expect(d.rule).toBe('R-SND-FEED');
    expect(d.targetAmount).toBe(eth('3000000'));
  });

  it('R-WD14: from exactly T-14d the market drains like RETIRED', () => {
    const d = decide(ptSusds(), cfg(), { nowSec: T14 });
    expect(d.rule).toBe('R-WD14');
    expect(d.targetAmount).toBe(0n);
    expect(d.sweep).toBe(true);
    expect(d.bandUtilBps).toBe(9400);
  });

  it('one second before T-14d it is still only grow-blocked (R-WD30)', () => {
    const d = decide(ptSusds(), cfg(), { nowSec: T14 - 1 });
    expect(d.rule).toBe('R-WD30');
    expect(d.sweep).toBe(false);
  });

  it('T-30 blocks only grows: a STEERED drain inside the window still executes', () => {
    const m = cbBtc({ maturityUtcSec: NOW + 20 * DAY }); // 20d to maturity: grow-blocked window
    const d = decide(m);
    expect(d.rule).toBe('R-MID93'); // the ~100k drain proceeds
    expect(d.targetAmount).toBe(invertedTarget(m, 9300));
  });

  it('T-30 blocks a STEERED grow (R-WD30)', () => {
    const m = cbBtc({
      totalSupplyAssets: eth('1000000'), totalBorrowAssets: eth('960000'),
      vaultAssets: eth('500000'), maturityUtcSec: NOW + 20 * DAY,
    });
    const d = decide(m);
    expect(d.rule).toBe('R-WD30');
    expect(d.targetAmount).toBe(m.vaultAssets);
  });
});

describe('RETIRED', () => {
  it('R-RETIRED: sweeps to zero at the drain band', () => {
    const m = cbBtc({ mode: 'RETIRED', vaultAssets: eth('500000') });
    const d = decide(m);
    expect(d.rule).toBe('R-RETIRED');
    expect(d.targetAmount).toBe(0n);
    expect(d.sweep).toBe(true);
    expect(d.bandUtilBps).toBe(9400);
  });
});

describe('sleeve floor (12% of totalAssets)', () => {
  // Two STEERED markets in the drain band (supplyApy 1% < 2.011%) plus a RETIRED sweep.
  //   A: supply 2.0M, borrow 1.0M, vault 1.9M -> target ~963,830 (drain ~936,170)
  //   B: supply 1.5M, borrow 0.75M, vault 1.4M -> target ~697,872 (drain ~702,128)
  //   C: RETIRED, vault 0.5M -> target 0 (sweep)
  const mkA = () => cbBtc({
    index: 0, totalSupplyAssets: eth('2000000'), totalBorrowAssets: eth('1000000'),
    vaultAssets: eth('1900000'), supplyApy: 0.01, anchorApy: 0.02,
  });
  const mkB = () => wstEth({
    index: 1, totalSupplyAssets: eth('1500000'), totalBorrowAssets: eth('750000'),
    vaultAssets: eth('1400000'), supplyApy: 0.01, anchorApy: 0.02,
  });
  const mkC = () => cbBtc({ index: 2, mode: 'RETIRED', vaultAssets: eth('500000') });

  function run(totalAssets: bigint): BandDecision[] {
    return computeBandDecisions({
      markets: [mkA(), mkB(), mkC()], cfg: cfg(), ssrApy: SSR, totalAssets, nowSec: NOW,
    });
  }

  it('does not touch decisions when the summed targets sit above the floor', () => {
    // totalAssets 10M -> floor 1.2M < summed targets ~1.66M.
    const [dA, dB, dC] = run(eth('10000000'));
    expect(dA.targetAmount).toBe(invertedTarget(mkA(), 9400));
    expect(dB.targetAmount).toBe(invertedTarget(mkB(), 9400));
    expect(dC.targetAmount).toBe(0n);
    expect([dA, dB, dC].some(d => d.reasons.some(r => r.includes('R-FLOOR')))).toBe(false);
  });

  it('restores the LARGEST drain first, exactly up to the floor', () => {
    // totalAssets 20M -> floor 2.4M. Summed targets ~1.6617M, deficit ~738k.
    // A's drain (~936k) > B's (~702k), so only A is partially restored.
    const floor = eth('20000000') * 1200n / 10000n;
    const [dA, dB, dC] = run(eth('20000000'));

    expect(dB.targetAmount).toBe(invertedTarget(mkB(), 9400));   // untouched
    expect(dC.targetAmount).toBe(0n);                            // sweep never restored
    expect(dA.targetAmount).toBe(floor - dB.targetAmount);       // A absorbs the whole deficit
    expect(dA.targetAmount).toBeLessThan(mkA().vaultAssets);     // still a (smaller) drain
    expect(dA.targetAmount + dB.targetAmount + dC.targetAmount).toBe(floor);

    // R-FLOOR appended to the adjusted decision only; rules unchanged.
    expect(dA.rule).toBe('R-DRAIN94');
    expect(dA.reasons.some(r => r.includes('R-FLOOR'))).toBe(true);
    expect(dB.reasons.some(r => r.includes('R-FLOOR'))).toBe(false);
    expect(dC.reasons.some(r => r.includes('R-FLOOR'))).toBe(false);
  });

  it('cascades to the next drain when the largest is fully restored, but never restores sweeps', () => {
    // totalAssets 30M -> floor 3.6M, deficit ~1.938M: A fully restored (1.9M), B fully
    // restored (1.4M), 300k of deficit remains but the RETIRED sweep must stay at 0 —
    // the sleeve legitimately ends below the floor.
    const [dA, dB, dC] = run(eth('30000000'));

    expect(dA.targetAmount).toBe(eth('1900000'));  // = vaultAssets, drain fully restored
    expect(dB.targetAmount).toBe(eth('1400000'));  // = vaultAssets, drain fully restored
    expect(dC.targetAmount).toBe(0n);              // RETIRED sweep NEVER restored
    expect(dC.sweep).toBe(true);

    expect(dA.rule).toBe('R-DRAIN94');
    expect(dB.rule).toBe('R-DRAIN94');
    expect(dA.reasons.some(r => r.includes('R-FLOOR'))).toBe(true);
    expect(dB.reasons.some(r => r.includes('R-FLOOR'))).toBe(true);
    expect(dC.reasons.some(r => r.includes('R-FLOOR'))).toBe(false);
  });

  it('never restores a T-14 winddown sweep', () => {
    // A drains ~936k; PT is inside T-14d (sweep). Huge floor forces restoration:
    // A comes back to its full position, PT stays swept to 0.
    const markets = [mkA(), ptSusds({ index: 1 })];
    const [dA, dPt] = computeBandDecisions({
      markets, cfg: cfg(), ssrApy: SSR, totalAssets: eth('30000000'),
      nowSec: PT_MATURITY - 14 * DAY,
    });
    expect(dPt.rule).toBe('R-WD14');
    expect(dPt.targetAmount).toBe(0n);
    expect(dPt.reasons.some(r => r.includes('R-FLOOR'))).toBe(false);
    expect(dA.targetAmount).toBe(eth('1900000')); // restored toward position instead
  });
});

describe('realistic 2026-07-30 multi-market cycle', () => {
  it('drains cbBTC and wstETH to the mid band and feeds the PT-sUSDS first tranche', () => {
    const markets = [cbBtc(), wstEth(), ptSusds()];
    // 35M vault: sleeve = 3.6 + 2.4 + 0.71 = 6.71M (~19%), floor 4.2M — inert here.
    const decisions = computeBandDecisions({
      markets, cfg: cfg(), ssrApy: SSR, totalAssets: eth('35000000'), nowSec: NOW,
    });

    expect(decisions.map(d => d.index)).toEqual([0, 1, 2]);

    const [dCb, dWst, dPt] = decisions;
    expect(dCb.rule).toBe('R-MID93');
    expect(dCb.targetAmount).toBe(invertedTarget(cbBtc(), 9300));
    expect(dCb.bandUtilBps).toBe(9300);

    expect(dWst.rule).toBe('R-MID93');
    expect(dWst.targetAmount).toBe(invertedTarget(wstEth(), 9300));

    expect(dPt.rule).toBe('R-SND-FEED');
    expect(dPt.targetAmount).toBe(eth('3000000'));
    expect(dPt.bandUtilBps).toBeUndefined();

    // No decision was floor-adjusted and none sweeps.
    for (const d of decisions) {
      expect(d.sweep).toBe(false);
      expect(d.reasons.some(r => r.includes('R-FLOOR'))).toBe(false);
    }
  });
});
