import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { AdaptiveCurveIrmLib } from '@morpho-org/blue-sdk';
import { sdkRateModel, optimizeAllocations, quantizeAllocationsToBps, buildRebalanceProposal, computeVaultApy, withUtilizationCeiling, TARGET_UTILIZATION_WAD, computeEffectiveMarketCap, computeReachableFloors, type OptimizerMarketState, type RateModel, type OptimizeInput, type ProposalInput } from './optimizer-logic.js';
import type { MarketLiquidity } from './allocation-logic.js';

const eth = parseEther;
const WAD = 1_000_000_000_000_000_000n;
const TS = 1_800_000_000n; // fixed timestamp for determinism

// Helper: market state with sane defaults. shares mirror assets 1:1; lastUpdate
// equals TS so accrual is a no-op and expectations stay exact.
function mkState(overrides: Partial<OptimizerMarketState> = {}): OptimizerMarketState {
  const supply = overrides.totalSupplyAssets ?? eth('1000');
  const borrow = overrides.totalBorrowAssets ?? eth('900');
  return {
    name: 'test/USDS',
    params: {
      loanToken: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
      collateralToken: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9',
      oracle: '0x0A976226d113B67Bd42D672Ac9f83f92B44b454C',
      irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
      lltv: 860000000000000000n,
    },
    totalSupplyAssets: supply,
    totalSupplyShares: supply * 1_000_000n, // SDK-style share scaling is irrelevant to rates
    totalBorrowAssets: borrow,
    totalBorrowShares: borrow * 1_000_000n,
    lastUpdate: TS,
    fee: 0n,
    rateAtTarget: AdaptiveCurveIrmLib.INITIAL_RATE_AT_TARGET,
    vaultAssets: 0n,
    effectiveCap: eth('1000000'),
    ...overrides,
  };
}

describe('sdkRateModel', () => {
  it('at target utilization (90%) the borrow rate equals rateAtTarget, so supply rate = rate * util * (1 - fee)', () => {
    const m = mkState({ totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('900') });
    const { supplyRateWad, utilizationWad } = sdkRateModel.rates(m, 0n, TS);
    expect(utilizationWad).toBe((eth('900') * WAD) / eth('1000'));
    const expected = Number(m.rateAtTarget) * 0.9; // fee = 0
    expect(Number(supplyRateWad)).toBeCloseTo(expected, -3); // wei-scale rounding tolerance
  });

  it('applies the market fee to the supply rate', () => {
    const noFee = sdkRateModel.rates(mkState({ fee: 0n }), 0n, TS).supplyRateWad;
    const withFee = sdkRateModel.rates(mkState({ fee: WAD / 10n }), 0n, TS).supplyRateWad;
    expect(Number(withFee)).toBeCloseTo(Number(noFee) * 0.9, -3);
  });

  it('matches AdaptiveCurveIrmLib.getBorrowRate below target utilization', () => {
    const m = mkState({ totalSupplyAssets: eth('2000'), totalBorrowAssets: eth('900') }); // util 45%
    const { supplyRateWad, utilizationWad } = sdkRateModel.rates(m, 0n, TS);
    const { endBorrowRate } = AdaptiveCurveIrmLib.getBorrowRate(utilizationWad, m.rateAtTarget, 0n);
    const expected = (Number(endBorrowRate) * Number(utilizationWad)) / 1e18;
    expect(Number(supplyRateWad)).toBeCloseTo(expected, -3);
  });

  it('adding vault allocation lowers utilization, supply rate, and APY (monotone)', () => {
    const m = mkState();
    const r0 = sdkRateModel.rates(m, 0n, TS);
    const r1 = sdkRateModel.rates(m, eth('500'), TS);
    expect(r1.utilizationWad).toBeLessThan(r0.utilizationWad);
    expect(r1.supplyRateWad).toBeLessThan(r0.supplyRateWad);
    expect(r1.supplyApy).toBeLessThan(r0.supplyApy);
    expect(r1.supplyApy).toBeGreaterThan(0);
  });

  it('alloc equal to current vaultAssets reproduces the live market state', () => {
    const m = mkState({ vaultAssets: eth('200') });
    const { utilizationWad } = sdkRateModel.rates(m, eth('200'), TS);
    expect(utilizationWad).toBe((m.totalBorrowAssets * WAD) / m.totalSupplyAssets);
  });

  it('handles the hypothetical zero-allocation baseline even past pool liquidity', () => {
    // Vault holds 500 of 1000 supply with 900 borrowed: removing the position
    // hypothetically leaves util 180%. Must not throw (Market.withdraw would).
    const m = mkState({ vaultAssets: eth('500') });
    const r = sdkRateModel.rates(m, 0n, TS);
    expect(r.utilizationWad).toBeGreaterThan(WAD);
    expect(r.supplyRateWad).toBeGreaterThan(0n);
  });

  it('zero borrows yield zero supply rate', () => {
    const m = mkState({ totalBorrowAssets: 0n, totalBorrowShares: 0n });
    const r = sdkRateModel.rates(m, eth('100'), TS);
    expect(r.supplyRateWad).toBe(0n);
    expect(r.supplyApy).toBe(0);
  });
});

// Analytic mock: supplyRate = utilization / 1000, monotone decreasing in added
// supply, so greedy behavior has closed-form-checkable properties.
const mockModel: RateModel = {
  rates(m, alloc) {
    const supply = m.totalSupplyAssets - m.vaultAssets + alloc;
    if (supply <= 0n || m.totalBorrowAssets === 0n) {
      return { supplyRateWad: 0n, supplyApy: 0, utilizationWad: 0n };
    }
    const utilizationWad = (m.totalBorrowAssets * WAD) / supply;
    const supplyRateWad = utilizationWad / 1000n;
    return { supplyRateWad, supplyApy: (Number(supplyRateWad) * 31_536_000) / 1e18, utilizationWad };
  },
};

function optInput(marketStates: OptimizerMarketState[], budget: bigint, over: Partial<OptimizeInput> = {}): OptimizeInput {
  return { totalAssets: eth('10000'), budget, markets: marketStates, blockTimestamp: TS, ...over };
}

// Total vault yield (WAD-rate-weighted) of an allocation vector under a model.
function totalYield(states: OptimizerMarketState[], allocs: bigint[], model: RateModel): bigint {
  return allocs.reduce((sum, a, i) => sum + (a === 0n ? 0n : a * model.rates(states[i], a, TS).supplyRateWad), 0n);
}

describe('optimizeAllocations', () => {
  it('splits the budget equally between two identical markets (within one chunk)', () => {
    const states = [mkState(), mkState()];
    const budget = eth('2000');
    const { allocations, usedBudget, idleBudget } = optimizeAllocations(optInput(states, budget), mockModel);
    expect(usedBudget).toBe(budget);
    expect(idleBudget).toBe(0n);
    const chunk = budget / 200n;
    const diff = allocations[0] > allocations[1] ? allocations[0] - allocations[1] : allocations[1] - allocations[0];
    expect(diff <= chunk).toBe(true);
  });

  it('is within 0.1% of the brute-force optimum for two asymmetric markets', () => {
    const states = [
      mkState({ totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('900') }),
      mkState({ totalSupplyAssets: eth('5000'), totalBorrowAssets: eth('2000') }),
    ];
    const budget = eth('2000');
    const { allocations } = optimizeAllocations(optInput(states, budget), mockModel);
    let best = 0n;
    for (let k = 0n; k <= 400n; k++) {
      const a = (budget * k) / 400n;
      const y = totalYield(states, [a, budget - a], mockModel);
      if (y > best) best = y;
    }
    expect(totalYield(states, allocations, mockModel) * 1000n >= best * 999n).toBe(true);
  });

  it('respects per-market effective caps', () => {
    const states = [mkState({ effectiveCap: eth('300') }), mkState()];
    const { allocations, usedBudget } = optimizeAllocations(optInput(states, eth('2000')), mockModel);
    expect(allocations[0]).toBe(eth('300'));
    expect(allocations[1]).toBe(eth('1700'));
    expect(usedBudget).toBe(eth('2000'));
  });

  it('leaves budget idle when caps sum below the budget', () => {
    const states = [mkState({ effectiveCap: eth('300') }), mkState({ effectiveCap: eth('400') })];
    const { usedBudget, idleBudget } = optimizeAllocations(optInput(states, eth('2000')), mockModel);
    expect(usedBudget).toBe(eth('700'));
    expect(idleBudget).toBe(eth('1300'));
  });

  it('allocates nothing when no market has borrows', () => {
    const states = [mkState({ totalBorrowAssets: 0n }), mkState({ totalBorrowAssets: 0n })];
    const { allocations, usedBudget, idleBudget } = optimizeAllocations(optInput(states, eth('2000')), mockModel);
    expect(allocations).toEqual([0n, 0n]);
    expect(usedBudget).toBe(0n);
    expect(idleBudget).toBe(eth('2000'));
  });

  it('handles a single market and zero budget', () => {
    const one = optimizeAllocations(optInput([mkState()], eth('500')), mockModel);
    expect(one.allocations).toEqual([eth('500')]);
    const zero = optimizeAllocations(optInput([mkState()], 0n), mockModel);
    expect(zero.allocations).toEqual([0n]);
    expect(zero.idleBudget).toBe(0n);
  });
});

describe('quantizeAllocationsToBps', () => {
  it('floors each market and gives the remainder to the largest allocation', () => {
    const totalAssets = eth('10000');
    // 3.33%, 6.67%, 9.99% -> floors 333, 666, 999 = 1998; used total floor = 1999
    const allocs = [eth('333.4'), eth('666.5'), eth('999.5')];
    const bps = quantizeAllocationsToBps(allocs, totalAssets);
    expect(bps.reduce((s, b) => s + b, 0)).toBe(1999);
    expect(bps).toEqual([333, 666, 1000]);
  });

  it('sums exactly to the used budget in bps', () => {
    const totalAssets = eth('10000');
    const allocs = [eth('500'), eth('500'), eth('500'), eth('500')];
    expect(quantizeAllocationsToBps(allocs, totalAssets)).toEqual([500, 500, 500, 500]);
  });

  it('returns zeros for zero totalAssets', () => {
    expect(quantizeAllocationsToBps([eth('1')], 0n)).toEqual([0]);
  });
});

function proposalInput(over: Partial<ProposalInput> = {}): ProposalInput {
  // Defaults: 2 markets, deep liquidity, adapter far below its cap.
  return {
    current: [eth('500'), eth('500')],
    optimal: [eth('500'), eth('500')],
    liquidity: [
      { marketIndex: 0, totalSupplyAssets: eth('100000'), totalBorrowAssets: eth('50000') },
      { marketIndex: 1, totalSupplyAssets: eth('100000'), totalBorrowAssets: eth('50000') },
    ],
    minAmount: eth('100'),
    adapterCap: eth('10000'),
    adapterAssets: eth('1000'),
    ...over,
  };
}

describe('buildRebalanceProposal', () => {
  it('returns no actions when current equals optimal', () => {
    const p = buildRebalanceProposal(proposalInput());
    expect(p.target).toEqual([]);
    expect(p.feasible).toEqual([]);
    expect(p.liquidityLimited).toBe(false);
  });

  it('suppresses diffs below the dust floor', () => {
    const p = buildRebalanceProposal(proposalInput({ optimal: [eth('550'), eth('450')] }));
    expect(p.target).toEqual([]);
  });

  it('emits matching deallocate/allocate pairs for a shift', () => {
    const p = buildRebalanceProposal(proposalInput({ optimal: [eth('900'), eth('100')] }));
    expect(p.target).toEqual([
      { marketIndex: 0, action: 'allocate', amount: eth('400') },
      { marketIndex: 1, action: 'deallocate', amount: eth('400') },
    ]);
    expect(p.feasible).toEqual([
      { marketIndex: 1, action: 'deallocate', amount: eth('400') },
      { marketIndex: 0, action: 'allocate', amount: eth('400') },
    ]);
    expect(p.liquidityLimited).toBe(false);
  });

  it('caps deallocations to available liquidity and flags it', () => {
    // Market 1 pool: 1000 supply, 950 borrowed -> 50 liquidity, minus 5% reserve = 0
    // (reserve = 50) -> nothing withdrawable.
    const p = buildRebalanceProposal(proposalInput({
      optimal: [eth('900'), eth('100')],
      liquidity: [
        { marketIndex: 0, totalSupplyAssets: eth('100000'), totalBorrowAssets: eth('50000') },
        { marketIndex: 1, totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('950') },
      ],
    }));
    expect(p.target.length).toBe(2);
    expect(p.feasible.some(a => a.action === 'deallocate')).toBe(false);
    expect(p.liquidityLimited).toBe(true);
  });

  it('caps allocations to the aggregate adapter budget', () => {
    // Adapter already at cap: no allocation may execute, deallocation still does.
    const p = buildRebalanceProposal(proposalInput({
      optimal: [eth('900'), eth('100')],
      adapterCap: eth('1000'),
      adapterAssets: eth('1000'),
    }));
    const feasibleAllocs = p.feasible.filter(a => a.action === 'allocate');
    const feasibleDeallocs = p.feasible.filter(a => a.action === 'deallocate');
    expect(feasibleDeallocs).toEqual([{ marketIndex: 1, action: 'deallocate', amount: eth('400') }]);
    // Budget after the 400 deallocation is 400, so the allocation fits exactly.
    expect(feasibleAllocs).toEqual([{ marketIndex: 0, action: 'allocate', amount: eth('400') }]);
    // Now with NO deallocation freeing room, allocation must be dropped entirely.
    const blocked = buildRebalanceProposal(proposalInput({
      current: [eth('500'), eth('500')],
      optimal: [eth('900'), eth('500')],
      adapterCap: eth('1000'),
      adapterAssets: eth('1000'),
    }));
    expect(blocked.feasible).toEqual([]);
    expect(blocked.liquidityLimited).toBe(true);
  });
});

describe('computeVaultApy', () => {
  it('weights per-market APY by allocation over totalAssets, idle at zero', () => {
    const states = [mkState(), mkState({ totalBorrowAssets: 0n })];
    const allocs = [eth('2000'), eth('1000')];
    const apy = computeVaultApy(states, allocs, eth('10000'), TS, mockModel);
    const expected = mockModel.rates(states[0], eth('2000'), TS).supplyApy * 0.2; // market 2 yields 0
    expect(apy).toBeCloseTo(expected, 10);
  });

  it('returns zero for zero totalAssets', () => {
    expect(computeVaultApy([mkState()], [eth('1')], 0n, TS, mockModel)).toBe(0);
  });
});

describe('withUtilizationCeiling', () => {
  const ceiled = withUtilizationCeiling(mockModel);

  it('passes through states at or below the ceiling', () => {
    const m = mkState({ totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('900') }); // util 90%
    expect(ceiled.rates(m, 0n, TS)).toEqual(mockModel.rates(m, 0n, TS));
  });

  it('scores above-ceiling states at the ceiling-state rate, keeping real utilization', () => {
    // base supply (without the vault) = 500, borrow 900 -> util 180% at alloc 0.
    const m = mkState({ totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('900'), vaultAssets: eth('500') });
    const real = mockModel.rates(m, 0n, TS);
    const scored = ceiled.rates(m, 0n, TS);
    // Smallest alloc reaching 90%: borrow / 0.9 - baseSupply = 1000 - 500 = 500.
    const atCeiling = mockModel.rates(m, eth('500'), TS);
    expect(scored.supplyRateWad).toBe(atCeiling.supplyRateWad);
    expect(scored.supplyApy).toBe(atCeiling.supplyApy);
    expect(scored.utilizationWad).toBe(real.utilizationWad);
  });

  it('fills a dominated market up to the utilization ceiling, not beyond', () => {
    // Sole-supplier market: with ceiling scoring the optimum for a sole supplier is
    // the allocation reaching the IRM target utilization; deploying beyond it
    // reduces total yield (borrowers pay less) while idle earns zero.
    const m = mkState({
      totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('900'),
      vaultAssets: eth('1000'), effectiveCap: eth('10000'),
    });
    const { usedBudget, idleBudget } = optimizeAllocations(
      optInput([m], eth('2000')), withUtilizationCeiling(mockModel));
    expect(usedBudget).toBe(eth('1000'));
    expect(idleBudget).toBe(eth('1000'));
  });
});

describe('optimizeAllocations with minAllocations floors', () => {
  it('never allocates below a floor and distributes only the remainder', () => {
    const states = [mkState(), mkState()];
    const { allocations, usedBudget, overBudget } = optimizeAllocations(
      optInput(states, eth('1000'), { minAllocations: [eth('300'), 0n] }), mockModel);
    expect(allocations[0] >= eth('300')).toBe(true);
    expect(usedBudget).toBe(eth('1000'));
    expect(overBudget).toBe(0n);
  });

  it('returns exactly the floors with overBudget when floors exceed the budget', () => {
    const states = [mkState(), mkState()];
    const { allocations, usedBudget, idleBudget, overBudget } = optimizeAllocations(
      optInput(states, eth('1000'), { minAllocations: [eth('800'), eth('400')] }), mockModel);
    expect(allocations).toEqual([eth('800'), eth('400')]);
    expect(usedBudget).toBe(eth('1200'));
    expect(idleBudget).toBe(0n);
    expect(overBudget).toBe(eth('200'));
  });

  it('omitted minAllocations behaves as all-zero floors', () => {
    const states = [mkState(), mkState()];
    const withOmitted = optimizeAllocations(optInput(states, eth('2000')), mockModel);
    const withZeros = optimizeAllocations(
      optInput(states, eth('2000'), { minAllocations: [0n, 0n] }), mockModel);
    expect(withOmitted.allocations).toEqual(withZeros.allocations);
    expect(withOmitted.overBudget).toBe(0n);
  });

  it('rejects a minAllocations length mismatch', () => {
    expect(() => optimizeAllocations(
      optInput([mkState()], eth('1000'), { minAllocations: [0n, 0n] }), mockModel)).toThrow();
  });
});

describe('computeEffectiveMarketCap', () => {
  it('applies CAP_HEADROOM_BPS to the relative-cap limit', () => {
    // 10% of 10M = 1M; minus 1 bps headroom.
    const cap = computeEffectiveMarketCap(eth('10000000'), 100000000000000000n);
    expect(cap).toBe(eth('1000000') - eth('1000000') / 10000n);
  });

  it('clamps to the absolute cap when it is lower than the relative limit', () => {
    // 10% of 100M = 10M; the 5M absolute cap wins.
    const cap = computeEffectiveMarketCap(eth('100000000'), 100000000000000000n, eth('5000000'));
    expect(cap).toBe(eth('5000000'));
  });

  it('ignores an absolute cap above the relative limit', () => {
    // 10% of 10M = 1M (with headroom); the 5M absolute cap is not binding.
    const cap = computeEffectiveMarketCap(eth('10000000'), 100000000000000000n, eth('5000000'));
    expect(cap).toBe(eth('1000000') - eth('1000000') / 10000n);
  });
});

describe('computeReachableFloors', () => {
  it('flat-reserve market: floor is the position minus (liquidity - 5% reserve)', () => {
    // Pool: 1000 supply, 900 borrowed -> 100 liquidity, reserve 50 -> 50 withdrawable.
    const floors = computeReachableFloors(
      [eth('200')],
      [{ marketIndex: 0, totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('900') }],
    );
    expect(floors).toEqual([eth('150')]);
  });

  it('fully-withdrawable position has a zero floor', () => {
    const floors = computeReachableFloors(
      [eth('100')],
      [{ marketIndex: 0, totalSupplyAssets: eth('10000'), totalBorrowAssets: eth('1000') }],
    );
    expect(floors).toEqual([0n]);
  });

  it('maxUtilizationBps market: floor respects the post-withdraw utilization target', () => {
    // supply 1000, borrow 900, max util 93%: min remaining supply = ceil(borrow / 0.93),
    // withdrawable = supply - that; the floor is the position minus withdrawable.
    const supply = eth('1000');
    const borrow = eth('900');
    const minSupplyAfter = (borrow * 10000n + 9299n) / 9300n;
    const withdrawable = supply - minSupplyAfter;
    const floors = computeReachableFloors(
      [eth('500')],
      [{ marketIndex: 0, totalSupplyAssets: supply, totalBorrowAssets: borrow, maxUtilizationBps: 9300 }],
    );
    expect(floors).toEqual([eth('500') - withdrawable]);
  });

  it('market already above maxUtilizationBps: nothing withdrawable, floor is the full position', () => {
    // util 95% > 93% -> capDeallocationsToLiquidity skips (wait for repayments).
    const floors = computeReachableFloors(
      [eth('500')],
      [{ marketIndex: 0, totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('950'), maxUtilizationBps: 9300 }],
    );
    expect(floors).toEqual([eth('500')]);
  });
});

describe('buildRebalanceProposal with maxUtilizationBps (WETH drain rule)', () => {
  it('caps feasible deallocations by the utilization rule, not the flat reserve', () => {
    // Market 1 at 95% utilization with maxUtilizationBps 9300: nothing withdrawable,
    // so the target proposes the shift but the feasible set holds no deallocation.
    const p = buildRebalanceProposal(proposalInput({
      optimal: [eth('900'), eth('100')],
      liquidity: [
        { marketIndex: 0, totalSupplyAssets: eth('100000'), totalBorrowAssets: eth('50000') },
        { marketIndex: 1, totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('950'), maxUtilizationBps: 9300 },
      ],
    }));
    expect(p.target.length).toBe(2);
    expect(p.feasible.some(a => a.action === 'deallocate')).toBe(false);
    expect(p.liquidityLimited).toBe(true);
  });
});
