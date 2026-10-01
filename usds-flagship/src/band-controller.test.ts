import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { computeBandDecisions, type MarketObservation } from './band-controller.js';
import { parseBandConfig } from './band-config.js';

// Production rate shape: SSR 3.52% -> SSR_t = 3.77%, HOLD zone [3.52%, 4.02%],
// band thresholds 2/3 x SSR_t = 2.513%, 1/3 x SSR_t = 1.257%, 1/12 x SSR_t = 0.314%.
const SSR_APY = 0.0352;
// Derived exactly the way the controller derives it, so exact-at-threshold probes
// share the controller's floating-point value bit for bit.
const SSR_T = SSR_APY + 25 / 10000;

// Defaults (tolerance 25, deadband 50, min action 10k, min priority withdrawal 50k,
// cooldown 24h, monopolist 8000) plus 1M step caps, with an explicit 25 bps margin so
// the ladder fixtures below sit on SSR_t = SSR + 25 bps (the default margin is 0).
const cfg = parseBandConfig({ MAX_ALLOCATE_USDS: '1000000', MAX_DEALLOCATE_USDS: '1000000', SSR_T_MARGIN_BPS: '25' });

const NOW = 1_785_628_800; // 2026-08-02T00:00:00Z

/**
 * cbBTC/USDS-like STEERED market: 4.2M supply, 3.72M borrow (util 88.57%), the vault
 * holding 4.1M of the supply (97.6% share). anchor 2.30% -> satAPY 2.07%, which lands
 * in [1/3 x SSR_t, 2/3 x SSR_t) -> band 93.
 */
function market(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    index: 0,
    name: 'cbBTC/USDS',
    mode: 'STEERED',
    totalSupplyAssets: parseEther('4200000'),
    totalBorrowAssets: parseEther('3720000'),
    vaultAssets: parseEther('4100000'),
    anchorApy: 0.023,
    marketCap: parseEther('10000000'),
    effectiveCap: parseEther('10000000'),
    ...overrides,
  };
}

/**
 * A smaller STEERED market for min-action probes: 930k borrow, band 93 -> target
 * supply exactly 1.0M. At the 4.2M fixture a 10k delta moves utilization only ~23
 * bps — inside the 50 bps deadband, which then fires first — while here the same
 * delta sits 93 bps off the band, so the min action is the gate under test.
 */
function smallMarket(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return market({
    name: 'wstETH/USDS',
    totalSupplyAssets: parseEther('1010000'),
    totalBorrowAssets: parseEther('930000'),
    vaultAssets: parseEther('1000000'),
    ...overrides,
  });
}

// The executor's default withdrawal cushion (LIQUIDITY_RESERVE_PERCENT).
const LIQUIDITY_RESERVE_PERCENT = 5n;

function decide(m: MarketObservation) {
  return computeBandDecisions({
    markets: [m], cfg, ssrApy: SSR_APY, nowSec: NOW, liquidityReservePercent: LIQUIDITY_RESERVE_PERCENT,
  })[0];
}

/**
 * Band the ladder picks for a market whose satAPY is exactly `satApy`
 * (anchor = satApy / 0.9 survives the controller's 0.9x round trip losslessly for
 * every probed value). Gate holds still report the chosen band in bandUtilBps.
 */
function bandAt(satApy: number): number | 'HOLD' | undefined {
  const d = decide(market({ anchorApy: satApy / 0.9 }));
  return d.rule === 'R-HOLD' ? 'HOLD' : d.bandUtilBps;
}

describe('the satAPY ladder off SSR_t', () => {
  it('chooses band 90 when satAPY clears the top of the zone', () => {
    expect(bandAt(0.0403)).toBe(9000);
  });

  it('holds at the top edge of the zone (4.02%)', () => {
    expect(bandAt(0.0402)).toBe('HOLD');
  });

  it('holds at SSR_t itself', () => {
    expect(bandAt(0.0377)).toBe('HOLD');
  });

  it('holds at the bottom edge of the zone — exactly SSR (3.52%)', () => {
    expect(bandAt(0.0352)).toBe('HOLD');
  });

  it('chooses band 92 just under the zone', () => {
    expect(bandAt(0.0351)).toBe(9200);
  });

  it('chooses band 92 at exactly 2/3 x SSR_t', () => {
    expect(bandAt((2 / 3) * SSR_T)).toBe(9200);
  });

  it('chooses band 93 just below 2/3 x SSR_t (2.51%)', () => {
    expect(bandAt(0.0251)).toBe(9300);
  });

  it('chooses band 93 at exactly 1/3 x SSR_t', () => {
    expect(bandAt((1 / 3) * SSR_T)).toBe(9300);
  });

  it('chooses band 94 just below 1/3 x SSR_t (1.25%)', () => {
    expect(bandAt(0.0125)).toBe(9400);
  });

  it('chooses band 94 at exactly 1/12 x SSR_t', () => {
    expect(bandAt((1 / 12) * SSR_T)).toBe(9400);
  });

  it('chooses band 95 just below 1/12 x SSR_t (0.31%)', () => {
    expect(bandAt(0.0031)).toBe(9500);
  });
});

describe('steering a market to its band', () => {
  it('withdraws down to the band target when utilization is below the band', () => {
    // Given the cbBTC fixture: band 93 wants supply 3.72M / 0.93 = 4.0M,
    // current supply is 4.2M -> the vault withdraws 200k.
    const d = decide(market());

    expect(d.rule).toBe('R-BAND93');
    expect(d.bandUtilBps).toBe(9300);
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('deposits up to the band target when utilization is above the band', () => {
    // Given supply 3.85M at the same 3.72M borrow (util 96.6%): band 93 wants
    // supply 4.0M -> the vault deposits 150k.
    const d = decide(market({ totalSupplyAssets: parseEther('3850000') }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('4250000'));
  });

  it('holds with no action when satAPY sits inside the zone', () => {
    // anchor 4.19% -> satAPY 3.771%, inside [3.52%, 4.02%].
    const d = decide(market({ anchorApy: 0.0419 }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('clamps the band target to the effective cap', () => {
    // anchor 4.6% -> satAPY 4.14% -> band 90 wants supply 3.6M / 0.9 = 4.0M from
    // supply 3.8M: a 200k deposit toward a 4.3M position — but the cap sits at 4.2M.
    const d = decide(market({
      anchorApy: 0.046,
      totalSupplyAssets: parseEther('3800000'),
      totalBorrowAssets: parseEther('3600000'),
      effectiveCap: parseEther('4200000'),
    }));

    expect(d.rule).toBe('R-BAND90');
    expect(d.targetAmount).toBe(parseEther('4200000'));
  });

  it('steers a market pinned at 100% utilization toward band 90 under the step cap', () => {
    // PT-sUSDS-like: 9.9M supply fully borrowed, heated anchor 4.6% -> band 90 wants
    // supply 11M — a 1.1M deposit, clamped to the 1M MAX_ALLOCATE step cap.
    const d = decide(market({
      name: 'PT-sUSDS/USDS',
      anchorApy: 0.046,
      totalSupplyAssets: parseEther('9900000'),
      totalBorrowAssets: parseEther('9900000'),
      vaultAssets: parseEther('9900000'),
      effectiveCap: parseEther('20000000'),
    }));

    expect(d.rule).toBe('R-BAND90');
    expect(d.targetAmount).toBe(parseEther('10900000'));
  });

  it('clamps an oversized drain to the step cap', () => {
    // Borrow 1.86M at band 93 wants supply 2.0M, current 4.2M: a 2.2M drain,
    // clamped to the 1M MAX_DEALLOCATE step cap.
    const d = decide(market({ totalBorrowAssets: parseEther('1860000') }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('3100000'));
  });

  it('leaves a band drain untouched by an on-chain cap below the position', () => {
    // Band 93 wants a 3.9M position; the on-chain cap at 3.5M bounds deposits only,
    // so the drain is the band's 200k, not the 600k a cap clamp would force.
    const d = decide(market({ effectiveCap: parseEther('3500000') }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('holds instead of draining when a grow is capped below the position', () => {
    // anchor 4.6% -> band 90 wants supply 4.0M from 3.8M: a 200k grow toward 4.3M,
    // but the on-chain cap sits at 3.5M, under the 4.1M position. The cap never turns
    // a grow into a drain (only a market-cap breach may), so the bounded delta is 0
    // and the market holds under the min action.
    const d = decide(market({
      anchorApy: 0.046,
      totalSupplyAssets: parseEther('3800000'),
      totalBorrowAssets: parseEther('3600000'),
      effectiveCap: parseEther('3500000'),
    }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('drains a market with no borrows toward zero under the step cap', () => {
    // No borrows -> any supply is idle: band 95 targets supply 0, the whole 4.1M
    // position wants out, clamped to the 1M MAX_DEALLOCATE step cap.
    const d = decide(market({ totalBorrowAssets: 0n, anchorApy: 0.001 }));

    expect(d.rule).toBe('R-BAND95');
    expect(d.targetAmount).toBe(parseEther('3100000'));
  });

  it('decides each market of a vector independently, in input order', () => {
    const decisions = computeBandDecisions({
      markets: [
        market({ index: 0 }),
        market({ index: 1, name: 'stUSDS/USDS', mode: 'RETIRED', vaultAssets: parseEther('2000000') }),
        market({ index: 2, name: 'wstETH/USDS', totalSupplyAssets: parseEther('3850000') }),
      ],
      cfg, ssrApy: SSR_APY, nowSec: NOW, liquidityReservePercent: LIQUIDITY_RESERVE_PERCENT,
    });

    expect(decisions.map(d => d.index)).toEqual([0, 1, 2]);
    expect(decisions.map(d => d.rule)).toEqual(['R-BAND93', 'R-RETIRED', 'R-BAND93']);
    expect(decisions.map(d => d.targetAmount)).toEqual([
      parseEther('3900000'), parseEther('2000000'), parseEther('4250000'),
    ]);
  });
});

describe('hold gates', () => {
  it('holds when utilization is already inside the deadband of the band', () => {
    // Supply 4.0M, borrow 3.72M -> util 9300, exactly the band.
    const d = decide(market({ totalSupplyAssets: parseEther('4000000') }));

    expect(d.rule).toBe('R-DEADBAND');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('holds at exactly 50 bps from the band (deadband is inclusive)', () => {
    // Supply 4.0M, borrow 3.7M -> util 9250, band 9300.
    const d = decide(market({
      totalSupplyAssets: parseEther('4000000'),
      totalBorrowAssets: parseEther('3700000'),
    }));

    expect(d.rule).toBe('R-DEADBAND');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('holds a grow the effective cap shrinks below the 10k min action', () => {
    // Band 93 wants a 150k deposit (util 9662, well outside the deadband) but the
    // cap allows only 9,999 of it — the clamped delta is what the min action sees.
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      effectiveCap: parseEther('4109999'),
    }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('executes a grow the effective cap shrinks to exactly the 10k min action', () => {
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      effectiveCap: parseEther('4110000'),
    }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('4110000'));
  });

  it('holds when the band delta is below the 10k min action', () => {
    // Supply 1,009,999 -> band target supply 1.0M -> a 9,999 drain, just under 10k,
    // at util 9207 (93 bps off the band, so the deadband stays quiet).
    const d = decide(smallMarket({ totalSupplyAssets: parseEther('1009999') }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.targetAmount).toBe(parseEther('1000000'));
  });

  it('executes a band delta of exactly the 10k min action', () => {
    // Supply 1.01M -> band target supply 1.0M -> a 10k drain, exactly at the floor.
    const d = decide(smallMarket());

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('990000'));
  });

  it('blocks a drain within 24h of the last allocate (direction cooldown)', () => {
    const d = decide(market({ lastAllocateAtSec: NOW - 23 * 3600 }));

    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('allows a drain exactly 24h after the last allocate', () => {
    const d = decide(market({ lastAllocateAtSec: NOW - 24 * 3600 }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('blocks a grow within 24h of the last deallocate (direction cooldown)', () => {
    // Deposit scenario (util above band) with a deallocate 1h ago.
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      lastDeallocateAtSec: NOW - 3600,
    }));

    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('does not block a drain following an earlier drain (same direction)', () => {
    const d = decide(market({ lastDeallocateAtSec: NOW - 3600 }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('blocks a drain when the vault is not the dominant supplier', () => {
    // Vault holds 3.0M of the 4.2M supply (71.4% < 80%): draining cannot move util.
    const d = decide(market({ vaultAssets: parseEther('3000000') }));

    expect(d.rule).toBe('R-SHARE');
    expect(d.targetAmount).toBe(parseEther('3000000'));
  });

  it('allows a drain at exactly the 80% monopolist share', () => {
    // Vault holds 3.36M of the 4.2M supply — exactly 8000 bps.
    const d = decide(market({ vaultAssets: parseEther('3360000') }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('3160000'));
  });

  it('still grows a market where the vault is a minority supplier', () => {
    // Deposit scenario (util above band) at a 26% vault share — grows are not gated
    // by the monopolist rule. Band 93 wants supply 4.0M from 3.85M -> deposit 150k.
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      vaultAssets: parseEther('1000000'),
    }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('1150000'));
  });
});

describe('steering gate order', () => {
  it('the deadband outranks the min action when both would hold', () => {
    // Supply 4,009,999 at 3.72M borrow: util 9276 (24 bps off band 93, inside the
    // deadband) and a 9,999 drain (under the min action) at once.
    const d = decide(market({ totalSupplyAssets: parseEther('4009999') }));

    expect(d.rule).toBe('R-DEADBAND');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('the min action outranks the direction cooldown when both would hold', () => {
    // A grow the cap clamps to 9,999, wished 1h after a deallocate.
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      effectiveCap: parseEther('4109999'),
      lastDeallocateAtSec: NOW - 3600,
    }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('the direction cooldown outranks the monopolist gate when both would hold', () => {
    // A 71.4% share drain 1h after an allocate.
    const d = decide(market({
      vaultAssets: parseEther('3000000'),
      lastAllocateAtSec: NOW - 3600,
    }));

    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.targetAmount).toBe(parseEther('3000000'));
  });
});

describe('anchor read sanity', () => {
  it('throws on a negative anchor read instead of steering off it', () => {
    expect(() => decide(market({ anchorApy: -0.01 }))).toThrow(/suspect read/);
  });

  it('throws on an absurd anchor read (above 1000% APY)', () => {
    expect(() => decide(market({ anchorApy: 12 }))).toThrow(/suspect read/);
  });

  it('throws on a non-finite anchor read', () => {
    expect(() => decide(market({ anchorApy: Number.NaN }))).toThrow(/suspect read/);
  });

  it('still decides at the IRM ceiling (200% APR compounds to ~639% APY)', () => {
    expect(() => decide(market({ anchorApy: 6.39 }))).not.toThrow();
  });
});

describe('market modes', () => {
  it('never touches a RETIRED market', () => {
    const d = decide(market({ mode: 'RETIRED', vaultAssets: parseEther('2000000') }));

    expect(d.rule).toBe('R-RETIRED');
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('2000000'));
  });

  it('throws on a SOUNDING market (not implemented)', () => {
    expect(() => decide(market({ mode: 'SOUNDING' }))).toThrow(/SOUNDING is not implemented/);
  });
});

describe('per-market SSR_t margin override', () => {
  it('lets a zero override move the zone below SSR (symmetric [SSR - 25, SSR + 25])', () => {
    // satAPY 3.40%: under the fixture's 25 bps margin the zone is [3.52%, 4.02%], so
    // the market would steer to band 92; with a 0 bps override the zone is
    // [3.27%, 3.77%] and it holds — a rate slightly under SSR is accepted.
    const d = decide(market({ anchorApy: 0.034 / 0.9, ssrTMarginBps: 0 }));

    expect(d.rule).toBe('R-HOLD');
    expect(decide(market({ anchorApy: 0.034 / 0.9 })).rule).toBe('R-BAND92');
  });

  it('a higher per-market margin moves the zone up and turns a hold into steering', () => {
    // satAPY 3.906% holds under the global margin (zone tops at 4.02%), but with a
    // 100 bps override SSR_t = 4.52% and the zone becomes [4.27%, 4.77%]: 3.906%
    // now sits above 2/3 x SSR_t = 3.01% -> band 92.
    const global = decide(market({ anchorApy: 0.0434 }));
    const overridden = decide(market({ anchorApy: 0.0434, ssrTMarginBps: 100 }));

    expect(global.rule).toBe('R-HOLD');
    expect(overridden.rule).toBe('R-BAND92');
    expect(overridden.bandUtilBps).toBe(9200);
  });
});

/**
 * PT-sUSDS/USDS as observed live on 2026-08-23, in its PRIMARY role: 2.415M supply
 * (all of it the vault's), 2.198M borrow (util 91%), anchor 2.93% — a satAPY of
 * 2.64% that steering would call band 92. Cap 4.04M = min(10% x TVL, 5M USDS), so
 * the fill wish is 1.625M — above the 1M MAX_ALLOCATE step cap.
 */
function ptPrimary(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return market({
    index: 3,
    name: 'PT-sUSDS/USDS',
    mode: 'PRIMARY',
    totalSupplyAssets: parseEther('2415000'),
    totalBorrowAssets: parseEther('2198000'),
    vaultAssets: parseEther('2415000'),
    anchorApy: 0.0293,
    marketCap: parseEther('4040000'),
    effectiveCap: parseEther('4040000'),
    ...overrides,
  });
}

// anchor 4.19% -> satAPY 3.771%, inside the HOLD zone [3.52%, 4.02%]: steering on its
// own would leave the cbBTC fixture exactly where it is.
const HOLD_ZONE_ANCHOR = 0.0419;

describe('priority deposit (PRIMARY)', () => {
  it('asks to be filled to its effective cap as a priority deposit', () => {
    // Given a cap 785k above the position — inside the step cap.
    const d = decide(ptPrimary({ effectiveCap: parseEther('3200000') }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('3200000'));
  });

  it('holds at its effective cap', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('2415000') }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2415000'));
  });

  it('holds above a shrunken on-chain relative cap while still under its market cap', () => {
    // The vault's relative cap clamps effectiveCap to 2.3M, below the 2.415M position,
    // but the position is under the 4.04M market cap — the on-chain relative cap is
    // not a breach trigger and PRIMARY never drains on its own.
    const d = decide(ptPrimary({ effectiveCap: parseEther('2300000') }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2415000'));
  });

  it('holds a fill just under the 10k min action', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('2424999') }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2415000'));
  });

  it('executes a fill of exactly the 10k min action', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('2425000') }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('2425000'));
  });

  it('holds a fill within 24h of the last deallocate (direction cooldown)', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('3200000'), lastDeallocateAtSec: NOW - 23 * 3600 }));

    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2415000'));
  });

  it('fills exactly 24h after the last deallocate', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('3200000'), lastDeallocateAtSec: NOW - 24 * 3600 }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.targetAmount).toBe(parseEther('3200000'));
  });

  it('keeps filling right after an earlier fill (same direction, no cooldown)', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('3200000'), lastAllocateAtSec: NOW - 3600 }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.targetAmount).toBe(parseEther('3200000'));
  });

  it('clamps the fill to the MAX_ALLOCATE step cap', () => {
    // The live 1.625M gap to the 4.04M cap, one 1M step at a time.
    const d = decide(ptPrimary());

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('3415000'));
  });

  it('decides identically whatever the anchor rate reads (no satAPY input)', () => {
    // 0.1% would be deep band 95 for a STEERED market, 8% would be band 90.
    const cold = decide(ptPrimary({ anchorApy: 0.001 }));
    const hot = decide(ptPrimary({ anchorApy: 0.08 }));

    expect(cold).toEqual(hot);
    expect(cold.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(cold.targetAmount).toBe(parseEther('3415000'));
  });

  it('does not throw on a garbage anchor read (the anchor is never consulted)', () => {
    expect(() => decide(ptPrimary({ anchorApy: Number.NaN }))).not.toThrow();
    expect(decide(ptPrimary({ anchorApy: Number.NaN })).rule).toBe('R-PRIORITY-DEPOSIT');
  });

  it('fills up to the on-chain bound alone when the market has no env cap', () => {
    // No env cap: effectiveCap is just the on-chain relative cap, as in bps mode.
    const d = decide(ptPrimary({ marketCap: undefined }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
  });
});

describe('shared wish sizing (PRIMARY and STEERED)', () => {
  it('holds a PRIMARY fill and a STEERED grow after a deallocate with one cooldown reason', () => {
    // Both wish a grow 1h after a deallocate: the same gate, the same trace.
    const primary = decide(ptPrimary({ effectiveCap: parseEther('3200000'), lastDeallocateAtSec: NOW - 3600 }));
    const steered = decide(market({ totalSupplyAssets: parseEther('3850000'), lastDeallocateAtSec: NOW - 3600 }));

    expect(primary.rule).toBe('R-COOLDOWN');
    expect(steered.rule).toBe('R-COOLDOWN');
    expect(primary.priority).toBe(false);
    expect(steered.priority).toBe(false);
    expect(primary.reasons.at(-1)).toMatch(/^grow 3600s after last deallocate \(2026-08-01T23:00:00.000Z\) < direction cooldown 24h -> hold$/);
    expect(steered.reasons.at(-1)).toBe(primary.reasons.at(-1));
  });

  it('clamps a PRIMARY fill and a STEERED grow of the same size to MAX_ALLOCATE with one trace', () => {
    // A 1.1M gap on both sides: PRIMARY to a 3.515M cap, STEERED (PT pinned at 100%
    // util, band 90 wants supply 11M from 9.9M). Each moves the 1M step cap.
    const primary = decide(ptPrimary({ effectiveCap: parseEther('3515000') }));
    const steered = decide(market({
      name: 'PT-sUSDS/USDS',
      anchorApy: 0.046,
      totalSupplyAssets: parseEther('9900000'),
      totalBorrowAssets: parseEther('9900000'),
      vaultAssets: parseEther('9900000'),
      effectiveCap: parseEther('20000000'),
    }));

    expect(primary.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(primary.targetAmount).toBe(parseEther('3415000'));
    expect(steered.rule).toBe('R-BAND90');
    expect(steered.targetAmount).toBe(parseEther('10900000'));
    expect(primary.reasons.at(-1)).toBe('grow 1100000 USDS clamped to step cap MAX_ALLOCATE 1000000 USDS');
    expect(steered.reasons.at(-1)).toBe(primary.reasons.at(-1));
  });
});

describe('priority withdrawal (cap breach)', () => {
  it('drains a STEERED market in the HOLD zone back to its cap as a priority withdrawal', () => {
    // Steering alone would hold (satAPY inside the zone), leaving the 4.1M position
    // 200k above a 3.9M cap forever. The pool can pay 270k (480k idle - 5% reserve).
    const d = decide(market({ anchorApy: HOLD_ZONE_ANCHOR, marketCap: parseEther('3900000') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('leaves a breach just under the 50k min priority withdrawal to steering', () => {
    // 49,999 USDS above the cap: steering decides, and in the HOLD zone it holds.
    const d = decide(market({ anchorApy: HOLD_ZONE_ANCHOR, marketCap: parseEther('4050001') }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('drains a breach of exactly the 50k min priority withdrawal', () => {
    const d = decide(market({ anchorApy: HOLD_ZONE_ANCHOR, marketCap: parseEther('4050000') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('4050000'));
  });

  it('drains a zero-cap market from the 100 USDS dust floor up, far under the 50k min', () => {
    // 100 USDS left in a market that must hold nothing: exactly the dust floor.
    const d = decide(market({ anchorApy: HOLD_ZONE_ANCHOR, marketCap: 0n, vaultAssets: parseEther('100') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(0n);
  });

  it('tolerates a zero-cap residue under the dust floor instead of chasing it', () => {
    // 99 USDS is not worth a Safe transaction; the market is left to steering.
    const d = decide(market({ anchorApy: HOLD_ZONE_ANCHOR, marketCap: 0n, vaultAssets: parseEther('99') }));

    expect(d.rule).not.toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('99'));
  });

  it('ignores a shrunken on-chain relative cap (only the market cap is a breach line)', () => {
    // effectiveCap 3.5M sits below the 4.1M position, marketCap 10M does not.
    const d = decide(market({ anchorApy: HOLD_ZONE_ANCHOR, effectiveCap: parseEther('3500000') }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('clamps the drain to the pool\'s withdrawable liquidity after the 5% reserve', () => {
    // Live PT-sUSDS: 2.415M supply - 2.198M borrow = 217k idle, minus the 5% reserve
    // of 120.75k -> 96.25k withdrawable, against a 415k breach of a 2.0M cap.
    const d = decide(ptPrimary({ marketCap: parseEther('2000000') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('2318750'));
  });

  it('holds with the priority-withdrawal rule when the pool has no withdrawable liquidity', () => {
    // 3.99M borrow leaves 210k idle — exactly the 5% reserve of 4.2M — so nothing
    // can be withdrawn; the drain retries next cycle.
    const d = decide(market({
      anchorApy: HOLD_ZONE_ANCHOR,
      marketCap: parseEther('3900000'),
      totalBorrowAssets: parseEther('3990000'),
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('holds when the withdrawable slice of a large breach is under the 50k min', () => {
    // 3.96M borrow leaves 240k idle, 30k after the 5% reserve — against a 415k
    // breach. A 30k drain would fund deposits in reconciliation and then be dropped,
    // so the market waits for borrowers to repay.
    const d = decide(market({
      anchorApy: HOLD_ZONE_ANCHOR,
      marketCap: parseEther('3685000'),
      totalBorrowAssets: parseEther('3960000'),
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('clamps the drain to the MAX_DEALLOCATE step cap', () => {
    // 1.0M borrow leaves 2.99M withdrawable; the 2.1M breach of a 2.0M cap is cut to 1M.
    const d = decide(market({
      anchorApy: HOLD_ZONE_ANCHOR,
      marketCap: parseEther('2000000'),
      totalBorrowAssets: parseEther('1000000'),
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('3100000'));
  });

  it('drains right after an allocate (no direction cooldown)', () => {
    const d = decide(market({
      anchorApy: HOLD_ZONE_ANCHOR,
      marketCap: parseEther('3900000'),
      lastAllocateAtSec: NOW - 3600,
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('drains a minority position (no monopolist gate)', () => {
    // The vault holds 420k of the 4.2M supply (10% share) with a 200k cap.
    const d = decide(market({
      anchorApy: HOLD_ZONE_ANCHOR,
      vaultAssets: parseEther('420000'),
      marketCap: parseEther('200000'),
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('200000'));
  });

  it('replaces a band deposit wish', () => {
    // Heated market (anchor 4.6%, util 92.86%): band 90 wants a 133k deposit.
    // Above a 3.9M cap the same market drains instead, to the 90k the pool can pay.
    const heated = { anchorApy: 0.046, totalBorrowAssets: parseEther('3900000') };
    const steered = decide(market(heated));
    const breached = decide(market({ ...heated, marketCap: parseEther('3900000') }));

    expect(steered.rule).toBe('R-BAND90');
    expect(steered.targetAmount).toBeGreaterThan(parseEther('4100000'));
    expect(breached.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(breached.priority).toBe(true);
    expect(breached.targetAmount).toBe(parseEther('4010000'));
  });

  it('drains a PRIMARY market above its cap through the same rule', () => {
    // A 65k breach the pool's 96.25k withdrawable covers in full.
    const d = decide(ptPrimary({ marketCap: parseEther('2350000') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('2350000'));
  });

  it('leaves a RETIRED market above its cap untouched', () => {
    const d = decide(market({ mode: 'RETIRED', vaultAssets: parseEther('2000000'), marketCap: parseEther('1000000') }));

    expect(d.rule).toBe('R-RETIRED');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2000000'));
  });

  it('holds a RETIRED market that carries no cap at all', () => {
    const d = decide(market({ mode: 'RETIRED', vaultAssets: parseEther('2000000'), marketCap: undefined }));

    expect(d.rule).toBe('R-RETIRED');
    expect(d.targetAmount).toBe(parseEther('2000000'));
  });

  it('never emits a priority withdrawal from a market with no env cap', () => {
    // Same fixture as the 200k band-93 drain: without an env cap there is no breach
    // line, so the market just steers — even with the position far above the
    // on-chain bound.
    const d = decide(market({ marketCap: undefined, effectiveCap: parseEther('1000000') }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });
});
