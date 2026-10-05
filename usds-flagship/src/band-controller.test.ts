import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { computeBandDecisions, type MarketObservation } from './band-controller.js';
import { parseBandConfig, type BandConfig } from './band-config.js';

// Production rate shape: SSR 3.52% -> target borrow rate 4.12% at the default 60 bps
// margin; a market resting within +-10 bps of it ([4.02%, 4.22%]) is left alone.
const SSR_APY = 0.0352;
const TARGET_RATE = SSR_APY + 60 / 10000;

// Defaults (margin 60, target utilization clamped to [8000, 9500], PRIMARY floor 80%,
// deadband 50, min action 10k, min priority withdrawal 50k, cooldown 24h, monopolist
// 8000) plus 1M step caps.
const cfg = parseBandConfig({ MAX_ALLOCATE_USDS: '1000000', MAX_DEALLOCATE_USDS: '1000000' });

const NOW = 1_785_628_800; // 2026-08-02T00:00:00Z

/**
 * Anchor APY at which the Adaptive Curve IRM prices a market at `borrowApy` when its
 * utilization is `util` (a fraction): the curve solved for the anchor, in the
 * per-second rate space the curve is linear in. anchorCharging(TARGET_RATE, 0.93) is
 * an anchor whose target utilization is exactly 93%; anchorCharging(TARGET_RATE, u)
 * at a fixture's current utilization u is an anchor that already rests.
 */
function anchorCharging(borrowApy: number, util: number): number {
  const err = util >= 0.9 ? (util - 0.9) / 0.1 : (util - 0.9) / 0.9;
  const curve = err >= 0 ? 1 + 3 * err : 1 + 0.75 * err;
  return Math.expm1(Math.log1p(borrowApy) / curve);
}

// Anchors that put the target utilization at 93% / 92% (heating) and 85% (cooling).
const ANCHOR_HEAT_93 = anchorCharging(TARGET_RATE, 0.93); // 2.148%
const ANCHOR_HEAT_92 = anchorCharging(TARGET_RATE, 0.92); // 2.580%
const ANCHOR_COOL_85 = anchorCharging(TARGET_RATE, 0.85); // 4.303%
// The cbBTC fixture's current utilization, 3.72M / 4.2M, and an anchor at which the
// fixture already pays exactly the target rate.
const FIXTURE_UTIL = 3.72 / 4.2;
const ANCHOR_RESTING = anchorCharging(TARGET_RATE, FIXTURE_UTIL); // 4.171%

/**
 * cbBTC/USDS-like STEERED market: 4.2M supply, 3.72M borrow (util 88.57%), the vault
 * holding 4.1M of the supply (97.6% share). anchor 2.148% pays 2.12% here, 200 bps
 * under the target: heat it to 93% utilization.
 */
function market(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    index: 0,
    name: 'cbBTC/USDS',
    mode: 'STEERED',
    totalSupplyAssets: parseEther('4200000'),
    totalBorrowAssets: parseEther('3720000'),
    vaultAssets: parseEther('4100000'),
    anchorApy: ANCHOR_HEAT_93,
    marketCap: parseEther('10000000'),
    effectiveCap: parseEther('10000000'),
    ...overrides,
  };
}

/**
 * A smaller STEERED market for min-action probes: 930k borrow, target 93% -> target
 * supply exactly 1.0M. At the 4.2M fixture a 10k delta moves utilization only ~23
 * bps — inside the 50 bps deadband, which then fires first — while here the same
 * delta sits 93 bps off the target, so the min action is the gate under test.
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

function decideWith(config: BandConfig, m: MarketObservation, ssrApy = SSR_APY) {
  return computeBandDecisions({
    markets: [m], cfg: config, ssrApy, nowSec: NOW, liquidityReservePercent: LIQUIDITY_RESERVE_PERCENT,
  })[0];
}

function decide(m: MarketObservation) {
  return decideWith(cfg, m);
}

describe('the rate target', () => {
  it('aims every steered market at SSR + 60 bps', () => {
    const d = decide(market());

    expect(d.targetRateApy).toBeCloseTo(0.0412, 12);
    expect(d.reasons[0]).toMatch(/^target rate 4\.120% = SSR 3\.520% \+ 60 bps; anchor 2\.148%, util 8857 bps -> borrow 2\.122% \(-200 bps off target\)$/);
  });

  it('heats a cheap market: holds it where the curve prices it at the target, above 90%', () => {
    // Given the cbBTC fixture at anchor 2.148%: the target rate is reached at 93%
    // utilization, so supply must fall to 3.72M / 0.93 = 4.0M — the vault withdraws 200k.
    const d = decide(market());

    expect(d.rule).toBe('R-HEAT');
    expect(d.regime).toBe('HEAT');
    expect(d.bandUtilBps).toBe(9300);
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('cools an expensive market: holds it where the curve prices it at the target, below 90%', () => {
    // anchor 4.303% pays 4.27% at util 89.05% (3.74M / 4.2M), 15 bps over the target;
    // the target rate is reached at 85%, so supply must rise to 3.74M / 0.85 = 4.4M.
    const d = decide(market({ anchorApy: ANCHOR_COOL_85, totalBorrowAssets: parseEther('3740000') }));

    expect(d.rule).toBe('R-COOL');
    expect(d.regime).toBe('COOL');
    expect(d.bandUtilBps).toBe(8500);
    expect(d.targetAmount).toBe(parseEther('4300000'));
  });

  it('withdraws in the COOL regime too when utilization sits under the cooling target', () => {
    // Same anchor at util 80.95% (3.4M / 4.2M): the rate is 14 bps under target, and
    // the 85% target supply of 4.0M is 200k below the current 4.2M. The regime names
    // where the anchor is headed, the sign of the delta names the action.
    const d = decide(market({ anchorApy: ANCHOR_COOL_85, totalBorrowAssets: parseEther('3400000') }));

    expect(d.rule).toBe('R-COOL');
    expect(d.bandUtilBps).toBe(8500);
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('rests with no action when the current borrow rate is already on target', () => {
    const d = decide(market({ anchorApy: ANCHOR_RESTING }));

    expect(d.rule).toBe('R-REST');
    expect(d.regime).toBe('REST');
    expect(d.bandUtilBps).toBe(8857);
    expect(d.targetAmount).toBe(parseEther('4100000'));
    expect(d.reasons.at(-1)).toBe('borrow rate within +-10 bps of target -> rest');
  });

  it('rests at exactly 10 bps above the target rate (the rest band is inclusive)', () => {
    expect(decide(market({ anchorApy: anchorCharging(TARGET_RATE + 0.0010, FIXTURE_UTIL) })).rule).toBe('R-REST');
  });

  it('rests at exactly 10 bps below the target rate', () => {
    expect(decide(market({ anchorApy: anchorCharging(TARGET_RATE - 0.0010, FIXTURE_UTIL) })).rule).toBe('R-REST');
  });

  it('cools a market paying 11 bps over the target', () => {
    const d = decide(market({ anchorApy: anchorCharging(TARGET_RATE + 0.0011, FIXTURE_UTIL) }));

    expect(d.rule).toBe('R-COOL');
    expect(d.bandUtilBps).toBe(8555);
    expect(d.targetAmount).toBeGreaterThan(parseEther('4100000'));
  });

  it('heats a market paying 11 bps under the target', () => {
    const d = decide(market({ anchorApy: anchorCharging(TARGET_RATE - 0.0011, FIXTURE_UTIL) }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.bandUtilBps).toBe(9005);
    expect(d.targetAmount).toBeLessThan(parseEther('4100000'));
  });

  it('follows a governance SSR change: a resting market heats once SSR rises 11 bps', () => {
    const resting = market({ anchorApy: ANCHOR_RESTING });

    expect(decideWith(cfg, resting, SSR_APY + 0.0010).rule).toBe('R-REST');
    expect(decideWith(cfg, resting, SSR_APY + 0.0011).rule).toBe('R-HEAT');
  });
});

describe('target utilization clamp', () => {
  it('clamps the target up to UTIL_MIN when the curve inverse falls below it', () => {
    // anchor 4.6% would need 77.7% utilization to pay 4.12%; the floor is 80%, so
    // supply rises to 3.72M / 0.8 = 4.65M — a 450k deposit.
    const d = decide(market({ anchorApy: 0.046 }));

    expect(d.rule).toBe('R-COOL');
    expect(d.bandUtilBps).toBe(8000);
    expect(d.targetAmount).toBe(parseEther('4550000'));
    expect(d.reasons).toContain('curve inverse 7773 bps clamped up to UTIL_MIN 8000 bps');
  });

  it("clamps the target down to UTIL_MAX when the target rate is beyond the curve's reach", () => {
    // anchor 1% cannot pay 4.12% anywhere (4 x anchor is the curve's end); the 95%
    // ceiling applies: supply 3.8M / 0.95 = 4.0M from 4.2M — a 200k drain.
    const d = decide(market({ anchorApy: 0.01, totalBorrowAssets: parseEther('3800000') }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.bandUtilBps).toBe(9500);
    expect(d.targetAmount).toBe(parseEther('3900000'));
    expect(d.reasons).toContain('curve inverse 10000 bps clamped down to UTIL_MAX 9500 bps');
  });

  it('honors a custom clamp from env', () => {
    const wide = parseBandConfig({ ...{ MAX_ALLOCATE_USDS: '1000000', MAX_DEALLOCATE_USDS: '1000000' }, UTIL_MIN_BPS: '8500', UTIL_MAX_BPS: '9700' });

    // Floor 85%: 3.4M / 0.85 = 4.0M. Ceiling 97%: 3.88M / 0.97 = 4.0M.
    const cooled = decideWith(wide, market({ anchorApy: 0.046, totalBorrowAssets: parseEther('3400000') }));
    const heated = decideWith(wide, market({ anchorApy: 0.01, totalBorrowAssets: parseEther('3880000') }));

    expect(cooled.bandUtilBps).toBe(8500);
    expect(cooled.targetAmount).toBe(parseEther('3900000'));
    expect(heated.bandUtilBps).toBe(9700);
    expect(heated.targetAmount).toBe(parseEther('3900000'));
  });
});

describe('steering a market to its target utilization', () => {
  it('deposits up to the target when utilization is above it', () => {
    // Given supply 3.85M at the same 3.72M borrow (util 96.6%): the 93% target wants
    // supply 4.0M -> the vault deposits 150k.
    const d = decide(market({ totalSupplyAssets: parseEther('3850000') }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('4250000'));
  });

  it('clamps the target to the effective cap', () => {
    // anchor 2.58% -> target 92%: supply 3.68M / 0.92 = 4.0M from 3.8M, a 200k
    // deposit toward a 4.3M position — but the cap sits at 4.2M.
    const d = decide(market({
      anchorApy: ANCHOR_HEAT_92,
      totalSupplyAssets: parseEther('3800000'),
      totalBorrowAssets: parseEther('3680000'),
      effectiveCap: parseEther('4200000'),
    }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.bandUtilBps).toBe(9200);
    expect(d.targetAmount).toBe(parseEther('4200000'));
  });

  it('steers a market pinned at 100% utilization to the 90% rest point under the step cap', () => {
    // PT-sUSDS-like: 9.9M supply fully borrowed, the anchor already at the target
    // rate -> the market pays 4x it; the rest point wants supply 11M — a 1.1M
    // deposit, clamped to the 1M MAX_ALLOCATE step cap. Holding at 90% is the top of
    // the heating range: the anchor stands still there.
    const d = decide(market({
      name: 'PT-sUSDS/USDS',
      anchorApy: TARGET_RATE,
      totalSupplyAssets: parseEther('9900000'),
      totalBorrowAssets: parseEther('9900000'),
      vaultAssets: parseEther('9900000'),
      effectiveCap: parseEther('20000000'),
    }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.bandUtilBps).toBe(9000);
    expect(d.targetAmount).toBe(parseEther('10900000'));
  });

  it('clamps an oversized drain to the step cap', () => {
    // Borrow 1.86M at the 93% target wants supply 2.0M, current 4.2M: a 2.2M drain,
    // clamped to the 1M MAX_DEALLOCATE step cap.
    const d = decide(market({ totalBorrowAssets: parseEther('1860000') }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('3100000'));
  });

  it('leaves a heating drain untouched by an on-chain cap below the position', () => {
    // The 93% target wants a 3.9M position; the on-chain cap at 3.5M bounds deposits
    // only, so the drain is the target's 200k, not the 600k a cap clamp would force.
    const d = decide(market({ effectiveCap: parseEther('3500000') }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('holds instead of draining when a grow is capped below the position', () => {
    // The 92% target wants supply 4.0M from 3.8M: a 200k grow toward 4.3M, but the
    // on-chain cap sits at 3.5M, under the 4.1M position. The cap never turns a grow
    // into a drain (only a market-cap breach may), so the bounded delta is 0 and the
    // market holds under the min action.
    const d = decide(market({
      anchorApy: ANCHOR_HEAT_92,
      totalSupplyAssets: parseEther('3800000'),
      totalBorrowAssets: parseEther('3680000'),
      effectiveCap: parseEther('3500000'),
    }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('drains a market with no borrows toward zero under the step cap', () => {
    // No borrows -> any supply is idle: the (clamped) 95% target wants supply 0, the
    // whole 4.1M position wants out, clamped to the 1M MAX_DEALLOCATE step cap.
    const d = decide(market({ totalBorrowAssets: 0n, anchorApy: 0.01 }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.bandUtilBps).toBe(9500);
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
    expect(decisions.map(d => d.rule)).toEqual(['R-HEAT', 'R-RETIRED', 'R-HEAT']);
    expect(decisions.map(d => d.targetAmount)).toEqual([
      parseEther('3900000'), parseEther('2000000'), parseEther('4250000'),
    ]);
  });
});

describe('hold gates', () => {
  it('holds when utilization is already inside the deadband of the target', () => {
    // Supply 4.0M, borrow 3.71M -> util 9275, 25 bps under the 93% target; the market
    // pays 3.96%, 16 bps under the target rate, so the rest check stays quiet and the
    // 10.7k drain the target asks for is the deadband's to refuse.
    const d = decide(market({ totalSupplyAssets: parseEther('4000000'), totalBorrowAssets: parseEther('3710000') }));

    expect(d.rule).toBe('R-DEADBAND');
    expect(d.regime).toBe('REST');
    expect(d.bandUtilBps).toBe(9300);
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('holds at exactly 50 bps from the target (deadband is inclusive)', () => {
    // Supply 4.0M, borrow 3.7M -> util 9250, target 9300.
    const d = decide(market({
      totalSupplyAssets: parseEther('4000000'),
      totalBorrowAssets: parseEther('3700000'),
    }));

    expect(d.rule).toBe('R-DEADBAND');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('holds a grow the effective cap shrinks below the 10k min action', () => {
    // The 93% target wants a 150k deposit (util 9662, well outside the deadband) but
    // the cap allows only 9,999 of it — the clamped delta is what the min action sees.
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      effectiveCap: parseEther('4109999'),
    }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.regime).toBe('HEAT');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('executes a grow the effective cap shrinks to exactly the 10k min action', () => {
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      effectiveCap: parseEther('4110000'),
    }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('4110000'));
  });

  it('holds when the delta to the target is below the 10k min action', () => {
    // Supply 1,009,999 -> target supply 1.0M -> a 9,999 drain, just under 10k, at
    // util 9207 (93 bps off the target, so the deadband stays quiet).
    const d = decide(smallMarket({ totalSupplyAssets: parseEther('1009999') }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.targetAmount).toBe(parseEther('1000000'));
  });

  it('executes a delta of exactly the 10k min action', () => {
    // Supply 1.01M -> target supply 1.0M -> a 10k drain, exactly at the floor.
    const d = decide(smallMarket());

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('990000'));
  });

  it('blocks a drain within 24h of the last allocate (direction cooldown)', () => {
    const d = decide(market({ lastAllocateAtSec: NOW - 23 * 3600 }));

    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.regime).toBe('HEAT');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('allows a drain exactly 24h after the last allocate', () => {
    const d = decide(market({ lastAllocateAtSec: NOW - 24 * 3600 }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('blocks a grow within 24h of the last deallocate (direction cooldown)', () => {
    // Deposit scenario (util above target) with a deallocate 1h ago.
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      lastDeallocateAtSec: NOW - 3600,
    }));

    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('does not block a drain following an earlier drain (same direction)', () => {
    const d = decide(market({ lastDeallocateAtSec: NOW - 3600 }));

    expect(d.rule).toBe('R-HEAT');
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

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('3160000'));
  });

  it('still grows a market where the vault is a minority supplier', () => {
    // Deposit scenario (util above target) at a 26% vault share — grows are not gated
    // by the monopolist rule. The 93% target wants supply 4.0M from 3.85M -> deposit 150k.
    const d = decide(market({
      totalSupplyAssets: parseEther('3850000'),
      vaultAssets: parseEther('1000000'),
    }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.targetAmount).toBe(parseEther('1150000'));
  });
});

describe('steering gate order', () => {
  it('the rest check outranks every gate: a resting market inside the deadband reports R-REST', () => {
    // Supply 4.0M at util 9300 with an anchor that pays the target rate right there.
    const d = decide(market({ totalSupplyAssets: parseEther('4000000'), anchorApy: anchorCharging(TARGET_RATE, 0.93) }));

    expect(d.rule).toBe('R-REST');
  });

  it('the deadband outranks the min action when both would hold', () => {
    // Supply 4,009,999 at 3.72M borrow: util 9276 (24 bps off the 93% target, inside
    // the deadband) and a 9,999 drain (under the min action) at once.
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
  it('throws on a zero anchor read (the IRM floors rateAtTarget at 0.1% APR)', () => {
    expect(() => decide(market({ anchorApy: 0 }))).toThrow(/suspect read/);
  });

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
    expect(d.regime).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('2000000'));
  });

  it('throws on a SOUNDING market (not implemented)', () => {
    expect(() => decide(market({ mode: 'SOUNDING' }))).toThrow(/SOUNDING is not implemented/);
  });
});

describe('per-market rate margin override', () => {
  it('a zero override aims at bare SSR and cools a market resting at SSR + 60', () => {
    // The fixture pays 4.12% = the global target; aimed at 3.52% it is 60 bps too
    // expensive. The curve inverse (71.6%) clamps to the 80% floor: supply
    // 3.72M / 0.8 = 4.65M, a 450k deposit.
    const d = decide(market({ anchorApy: ANCHOR_RESTING, rateMarginBps: 0 }));

    expect(d.rule).toBe('R-COOL');
    expect(d.bandUtilBps).toBe(8000);
    expect(d.targetAmount).toBe(parseEther('4550000'));
    expect(d.reasons[0]).toMatch(/^target rate 3\.520% = SSR 3\.520% \+ 0 bps \(per-market override\)/);
  });

  it('a higher override aims higher and heats a market resting at the global target', () => {
    // Aimed at SSR + 100 bps = 4.52%, the 4.12% the fixture pays is 40 bps short:
    // the rate target is reached at 90.27%.
    const d = decide(market({ anchorApy: ANCHOR_RESTING, rateMarginBps: 100 }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.bandUtilBps).toBe(9027);
    expect(d.targetRateApy).toBeCloseTo(0.0452, 12);
    expect(d.targetAmount).toBeLessThan(parseEther('4100000'));
  });
});

/**
 * PT-sUSDS/USDS as observed live on 2026-08-23, in its PRIMARY role: 2.415M supply
 * (all of it the vault's), 2.198M borrow (util 91%), anchor 2.93%. Cap 4.04M =
 * min(10% x TVL, 5M USDS). The 80% utilization floor sits at supply 2.198M / 0.8 =
 * 2.7475M, under the cap, so the fill wish is 332.5k — not the 1.625M gap to the cap.
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

/**
 * The same market pinned at 100% utilization: 9.9M supply fully borrowed, so the 80%
 * floor sits at supply 12.375M and only the cap (20M) or the step cap bounds a fill.
 */
function ptPinned(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return ptPrimary({
    totalSupplyAssets: parseEther('9900000'),
    totalBorrowAssets: parseEther('9900000'),
    vaultAssets: parseEther('9900000'),
    marketCap: parseEther('20000000'),
    effectiveCap: parseEther('20000000'),
    ...overrides,
  });
}

describe('priority deposit (PRIMARY)', () => {
  it('fills to its utilization floor as a priority deposit when the cap is further away', () => {
    const d = decide(ptPrimary());

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.regime).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('2747500'));
    expect(d.reasons[0]).toBe(
      'mode=PRIMARY: fill to min(effectiveCap 4040000 USDS, util floor 2747500 USDS = position at 80% util ' +
      'on borrow 2198000 USDS) from 2415000 USDS (delta +332500 USDS)');
  });

  it('fills to its effective cap when the cap is below the utilization floor', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('2700000') }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('2700000'));
  });

  it('holds exactly at the utilization floor', () => {
    const d = decide(ptPrimary({ totalSupplyAssets: parseEther('2747500'), vaultAssets: parseEther('2747500') }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2747500'));
    expect(d.reasons.at(-1)).toBe('at/above the 80% util floor -> hold');
  });

  it('holds above the utilization floor — the floor is never a withdrawal trigger', () => {
    // The 2026-10-05 shape: the position sits far above borrow / 0.8 (util 73%), so
    // PT asks for nothing and keeps what it has; room appears only as its borrow grows.
    const d = decide(ptPrimary({ totalSupplyAssets: parseEther('3000000'), vaultAssets: parseEther('3000000') }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('3000000'));
  });

  it('does not seed a market with no borrow at all', () => {
    // No demand -> the floor is at supply 0: nothing to fill. A PRIMARY market
    // bootstraps only once someone borrows from it.
    const d = decide(ptPrimary({ totalSupplyAssets: 0n, totalBorrowAssets: 0n, vaultAssets: 0n }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.targetAmount).toBe(0n);
  });

  it('holds at its effective cap', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('2415000') }));

    expect(d.rule).toBe('R-HOLD');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2415000'));
    expect(d.reasons.at(-1)).toBe('at/above effectiveCap -> hold');
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

  it('holds a fill to the floor just under the 10k min action', () => {
    const d = decide(ptPrimary({ totalSupplyAssets: parseEther('2737501'), vaultAssets: parseEther('2737501') }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2737501'));
  });

  it('executes a fill to the floor of exactly the 10k min action', () => {
    const d = decide(ptPrimary({ totalSupplyAssets: parseEther('2737500'), vaultAssets: parseEther('2737500') }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.targetAmount).toBe(parseEther('2747500'));
  });

  it('holds a fill to the cap just under the 10k min action', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('2424999') }));

    expect(d.rule).toBe('R-MINACTION');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2415000'));
  });

  it('executes a fill to the cap of exactly the 10k min action', () => {
    const d = decide(ptPrimary({ effectiveCap: parseEther('2425000') }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('2425000'));
  });

  it('follows PRIMARY_MIN_UTIL_PERCENT from env', () => {
    // A 70% floor sits at supply 2.198M / 0.7 = 3.14M: a 725k fill instead of 332.5k.
    const loose = parseBandConfig({ MAX_ALLOCATE_USDS: '1000000', MAX_DEALLOCATE_USDS: '1000000', PRIMARY_MIN_UTIL_PERCENT: '70' });
    const d = decideWith(loose, ptPrimary());

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.targetAmount).toBe(parseEther('3140000'));
  });

  it('holds a fill within 24h of the last deallocate (direction cooldown)', () => {
    const d = decide(ptPrimary({ lastDeallocateAtSec: NOW - 23 * 3600 }));

    expect(d.rule).toBe('R-COOLDOWN');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('2415000'));
  });

  it('fills exactly 24h after the last deallocate', () => {
    const d = decide(ptPrimary({ lastDeallocateAtSec: NOW - 24 * 3600 }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.targetAmount).toBe(parseEther('2747500'));
  });

  it('keeps filling right after an earlier fill (same direction, no cooldown)', () => {
    const d = decide(ptPrimary({ lastAllocateAtSec: NOW - 3600 }));

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.targetAmount).toBe(parseEther('2747500'));
  });

  it('clamps the fill to the MAX_ALLOCATE step cap', () => {
    // Pinned at 100%: the floor wants supply 12.375M, a 2.475M gap, one 1M step at a time.
    const d = decide(ptPinned());

    expect(d.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('10900000'));
  });

  it('decides identically whatever the anchor rate reads (no rate input)', () => {
    // 0.1% would heat a STEERED market to the 95% ceiling, 8% would cool it to the floor.
    const cold = decide(ptPrimary({ anchorApy: 0.001 }));
    const hot = decide(ptPrimary({ anchorApy: 0.08 }));

    expect(cold).toEqual(hot);
    expect(cold.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(cold.targetAmount).toBe(parseEther('2747500'));
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
    expect(d.targetAmount).toBe(parseEther('2747500'));
  });
});

describe('shared wish sizing (PRIMARY and STEERED)', () => {
  it('holds a PRIMARY fill and a STEERED grow after a deallocate with one cooldown reason', () => {
    // Both wish a grow 1h after a deallocate: the same gate, the same trace.
    const primary = decide(ptPrimary({ lastDeallocateAtSec: NOW - 3600 }));
    const steered = decide(market({ totalSupplyAssets: parseEther('3850000'), lastDeallocateAtSec: NOW - 3600 }));

    expect(primary.rule).toBe('R-COOLDOWN');
    expect(steered.rule).toBe('R-COOLDOWN');
    expect(primary.priority).toBe(false);
    expect(steered.priority).toBe(false);
    expect(primary.reasons.at(-1)).toMatch(/^grow 3600s after last deallocate \(2026-08-01T23:00:00.000Z\) < direction cooldown 24h -> hold$/);
    expect(steered.reasons.at(-1)).toBe(primary.reasons.at(-1));
  });

  it('clamps a PRIMARY fill and a STEERED grow of the same size to MAX_ALLOCATE with one trace', () => {
    // A 1.1M gap on both sides: PRIMARY pinned at 100% to an 11M cap (under its 12.375M
    // floor), STEERED pinned at 100% with the anchor on target (the rest point wants
    // supply 11M from 9.9M). Each moves the 1M step cap.
    const primary = decide(ptPinned({ effectiveCap: parseEther('11000000') }));
    const steered = decide(market({
      name: 'PT-sUSDS/USDS',
      anchorApy: TARGET_RATE,
      totalSupplyAssets: parseEther('9900000'),
      totalBorrowAssets: parseEther('9900000'),
      vaultAssets: parseEther('9900000'),
      effectiveCap: parseEther('20000000'),
    }));

    expect(primary.rule).toBe('R-PRIORITY-DEPOSIT');
    expect(primary.targetAmount).toBe(parseEther('10900000'));
    expect(steered.rule).toBe('R-HEAT');
    expect(steered.targetAmount).toBe(parseEther('10900000'));
    expect(primary.reasons.at(-1)).toBe('grow 1100000 USDS clamped to step cap MAX_ALLOCATE 1000000 USDS');
    expect(steered.reasons.at(-1)).toBe(primary.reasons.at(-1));
  });
});

describe('priority withdrawal (cap breach)', () => {
  it('drains a resting STEERED market back to its cap as a priority withdrawal', () => {
    // Steering alone would rest (the rate is on target), leaving the 4.1M position
    // 200k above a 3.9M cap forever. The pool can pay 270k (480k idle - 5% reserve).
    const d = decide(market({ anchorApy: ANCHOR_RESTING, marketCap: parseEther('3900000') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.bandUtilBps).toBeUndefined();
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('leaves a breach just under the 50k min priority withdrawal to steering', () => {
    // 49,999 USDS above the cap: steering decides, and on target it rests.
    const d = decide(market({ anchorApy: ANCHOR_RESTING, marketCap: parseEther('4050001') }));

    expect(d.rule).toBe('R-REST');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('4100000'));
  });

  it('drains a breach of exactly the 50k min priority withdrawal', () => {
    const d = decide(market({ anchorApy: ANCHOR_RESTING, marketCap: parseEther('4050000') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('4050000'));
  });

  it('drains a zero-cap market from the 100 USDS dust floor up, far under the 50k min', () => {
    // 100 USDS left in a market that must hold nothing: exactly the dust floor.
    const d = decide(market({ anchorApy: ANCHOR_RESTING, marketCap: 0n, vaultAssets: parseEther('100') }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(0n);
  });

  it('tolerates a zero-cap residue under the dust floor instead of chasing it', () => {
    // 99 USDS is not worth a Safe transaction; the market is left to steering.
    const d = decide(market({ anchorApy: ANCHOR_RESTING, marketCap: 0n, vaultAssets: parseEther('99') }));

    expect(d.rule).not.toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('99'));
  });

  it('ignores a shrunken on-chain relative cap (only the market cap is a breach line)', () => {
    // effectiveCap 3.5M sits below the 4.1M position, marketCap 10M does not.
    const d = decide(market({ anchorApy: ANCHOR_RESTING, effectiveCap: parseEther('3500000') }));

    expect(d.rule).toBe('R-REST');
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
      anchorApy: ANCHOR_RESTING,
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
      anchorApy: ANCHOR_RESTING,
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
      anchorApy: ANCHOR_RESTING,
      marketCap: parseEther('2000000'),
      totalBorrowAssets: parseEther('1000000'),
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('3100000'));
  });

  it('drains right after an allocate (no direction cooldown)', () => {
    const d = decide(market({
      anchorApy: ANCHOR_RESTING,
      marketCap: parseEther('3900000'),
      lastAllocateAtSec: NOW - 3600,
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });

  it('drains a minority position (no monopolist gate)', () => {
    // The vault holds 420k of the 4.2M supply (10% share) with a 200k cap.
    const d = decide(market({
      anchorApy: ANCHOR_RESTING,
      vaultAssets: parseEther('420000'),
      marketCap: parseEther('200000'),
    }));

    expect(d.rule).toBe('R-PRIORITY-WITHDRAWAL');
    expect(d.priority).toBe(true);
    expect(d.targetAmount).toBe(parseEther('200000'));
  });

  it('replaces a cooling deposit wish', () => {
    // Expensive market (anchor 4.6%, util 92.86%): the 80% floor wants a 675k deposit.
    // Above a 3.9M cap the same market drains instead, to the 90k the pool can pay.
    const expensive = { anchorApy: 0.046, totalBorrowAssets: parseEther('3900000') };
    const steered = decide(market(expensive));
    const breached = decide(market({ ...expensive, marketCap: parseEther('3900000') }));

    expect(steered.rule).toBe('R-COOL');
    expect(steered.targetAmount).toBe(parseEther('4775000'));
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
    // Same fixture as the 200k heating drain: without an env cap there is no breach
    // line, so the market just steers — even with the position far above the
    // on-chain bound.
    const d = decide(market({ marketCap: undefined, effectiveCap: parseEther('1000000') }));

    expect(d.rule).toBe('R-HEAT');
    expect(d.priority).toBe(false);
    expect(d.targetAmount).toBe(parseEther('3900000'));
  });
});
