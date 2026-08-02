import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { computeBandDecisions, pickBand, type MarketObservation } from './band-controller.js';
import { parseBandConfig } from './band-config.js';

// Production rate shape: SSR 3.52% -> SSR_t = 3.77%, HOLD zone [3.52%, 4.02%],
// band thresholds 2/3 x SSR_t = 2.513%, 1/3 x SSR_t = 1.257%, 1/12 x SSR_t = 0.314%.
const SSR_APY = 0.0352;
const SSR_T = 0.0377;
const TOLERANCE = 0.0025;

// Defaults (margin 25, tolerance 25, deadband 50, min action 100k, cooldown 24h,
// monopolist 8000) plus 1M step caps.
const cfg = parseBandConfig({ MAX_ALLOCATE_USDS: '1000000', MAX_DEALLOCATE_USDS: '1000000' });

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
    effectiveCap: parseEther('10000000'),
    ...overrides,
  };
}

function decide(m: MarketObservation) {
  return computeBandDecisions({ markets: [m], cfg, ssrApy: SSR_APY, nowSec: NOW })[0];
}

describe('pickBand (satAPY ladder off SSR_t)', () => {
  it('chooses band 90 when satAPY clears the top of the zone', () => {
    expect(pickBand(0.0403, SSR_T, TOLERANCE)).toBe(9000);
  });

  it('holds at the top edge of the zone (4.02%)', () => {
    expect(pickBand(0.0402, SSR_T, TOLERANCE)).toBe('HOLD');
  });

  it('holds at SSR_t itself', () => {
    expect(pickBand(0.0377, SSR_T, TOLERANCE)).toBe('HOLD');
  });

  it('holds at the bottom edge of the zone — exactly SSR (3.52%)', () => {
    expect(pickBand(0.0352, SSR_T, TOLERANCE)).toBe('HOLD');
  });

  it('chooses band 92 just under the zone', () => {
    expect(pickBand(0.0351, SSR_T, TOLERANCE)).toBe(9200);
  });

  it('chooses band 92 down to 2/3 x SSR_t (2.52%)', () => {
    expect(pickBand(0.0252, SSR_T, TOLERANCE)).toBe(9200);
  });

  it('chooses band 93 below 2/3 x SSR_t (2.51%)', () => {
    expect(pickBand(0.0251, SSR_T, TOLERANCE)).toBe(9300);
  });

  it('chooses band 93 down to 1/3 x SSR_t (1.26%)', () => {
    expect(pickBand(0.0126, SSR_T, TOLERANCE)).toBe(9300);
  });

  it('chooses band 94 below 1/3 x SSR_t (1.25%)', () => {
    expect(pickBand(0.0125, SSR_T, TOLERANCE)).toBe(9400);
  });

  it('chooses band 94 down to 1/12 x SSR_t (0.32%)', () => {
    expect(pickBand(0.0032, SSR_T, TOLERANCE)).toBe(9400);
  });

  it('chooses band 95 below 1/12 x SSR_t (0.31%)', () => {
    expect(pickBand(0.0031, SSR_T, TOLERANCE)).toBe(9500);
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
});

describe('hold gates', () => {
  it('holds when utilization is already inside the deadband of the band', () => {
    // Supply 4.0M, borrow 3.72M -> util 9300, exactly the band.
    const d = decide(market({ totalSupplyAssets: parseEther('4000000') }));

    expect(d.rule).toBe('R-DEADBAND');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('holds when the delta is below the 100k min action', () => {
    // Supply 4.099M -> band target supply 4.0M -> a 99k drain, just under 100k.
    const d = decide(market({ totalSupplyAssets: parseEther('4099000') }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('executes a delta of exactly the 100k min action', () => {
    // Supply 4.1M -> band target supply 4.0M -> a 100k drain, exactly at the floor.
    const d = decide(market({
      totalSupplyAssets: parseEther('4100000'),
      vaultAssets: parseEther('4000000'),
    }));

    expect(d.rule).toBe('R-BAND93');
    expect(d.targetAmount).toBe(parseEther('3900000'));
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
