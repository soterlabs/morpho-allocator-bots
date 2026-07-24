import { describe, it, expect } from 'vitest';
import { computeAllocationActions, computeCapLimit, bpsToWad, CAP_HEADROOM_BPS, capDeallocationsToLiquidity, LIQUIDITY_RESERVE_PERCENT, parseTargetBps, validateTargetBpsSum, shouldExecuteDeallocate, planDeallocations, planAllocations, capAllocationsToBudget, computeAllocationBudget, type AllocationInput, type AllocationAction, type MarketLiquidity, type DeallocatePlanItem, type AllocatePlanItem } from './allocation-logic.js';
import { parseEther } from 'viem';

// Helper: build an AllocationInput with sensible defaults (4 markets, 80/20 split, 5% each).
// targetPerMarketBpsByIndex defaults to [500, 500, 500, 500] sized to perMarketAssets.length
// so most tests don't have to repeat it. Override per test if asymmetric targets are needed.
function input(overrides: Partial<AllocationInput> & Pick<AllocationInput, 'totalAssets' | 'perMarketAssets'>): AllocationInput {
  const numMarkets = overrides.perMarketAssets.length;
  return {
    targetPerMarketBpsByIndex: new Array(numMarkets).fill(500),  // 5% each by default
    rebalanceThresholdBps: 100,    // 1%
    ...overrides,
  };
}

const eth = parseEther;

describe('computeCapLimit', () => {
  it('replicates vault mulDivDown(totalAssets, relativeCap, WAD)', () => {
    // 5% of 1000 USDS = 50 USDS
    expect(computeCapLimit(eth('1000'), bpsToWad(500))).toBe(eth('50'));
  });

  it('handles 100% cap', () => {
    expect(computeCapLimit(eth('1000'), bpsToWad(10000))).toBe(eth('1000'));
  });

  it('truncates fractional wei (integer division)', () => {
    // 5% of 1 wei = 0.05 wei → truncates to 0
    expect(computeCapLimit(1n, bpsToWad(500))).toBe(0n);
  });

  it('handles large totalAssets without overflow', () => {
    // 5% of 100M USDS
    expect(computeCapLimit(eth('100000000'), bpsToWad(500))).toBe(eth('5000000'));
  });

  it('handles zero totalAssets', () => {
    expect(computeCapLimit(0n, bpsToWad(500))).toBe(0n);
  });
});

describe('bpsToWad', () => {
  it('converts 500 bps (5%) to 5e16', () => {
    expect(bpsToWad(500)).toBe(50000000000000000n);
  });

  it('converts 10000 bps (100%) to 1e18', () => {
    expect(bpsToWad(10000)).toBe(1000000000000000000n);
  });

  it('converts 1 bps (0.01%) to 1e14', () => {
    expect(bpsToWad(1)).toBe(100000000000000n);
  });

  it('converts 0 bps to 0', () => {
    expect(bpsToWad(0)).toBe(0n);
  });
});

describe('CAP_HEADROOM_BPS', () => {
  it('is 1 bps', () => {
    expect(CAP_HEADROOM_BPS).toBe(1n);
  });

  it('applied to cap limit gives correct effective cap', () => {
    // Simulates what allocator.ts does:
    // effectiveCap = capLimit - capLimit * CAP_HEADROOM_BPS / 10000
    const capLimit = computeCapLimit(eth('20000000'), bpsToWad(500)); // 5% of $20M = $1M
    const headroom = capLimit * CAP_HEADROOM_BPS / 10000n;
    const effectiveCap = capLimit - headroom;

    expect(capLimit).toBe(eth('1000000'));
    expect(headroom).toBe(eth('100')); // $100 headroom on $1M cap
    expect(effectiveCap).toBe(eth('999900'));
  });

  it('headroom covers interest accrual at max rate over 10 minutes', () => {
    // Max rate = 200% APR, 10 min delay, $1M position
    // interest = $1M * 2.0 * 600 / 31_557_600 ≈ $38
    // gap = 0.8 * $38 ≈ $30 (80% because totalAssets grows slower than per-market interest)
    // headroom = $100 >> $30
    const capLimit = computeCapLimit(eth('20000000'), bpsToWad(500));
    const headroom = capLimit * CAP_HEADROOM_BPS / 10000n;
    const interestGap = eth('1000000') * 2n * 600n * 8n / (31_557_600n * 10n);

    expect(headroom).toBeGreaterThan(interestGap);
  });
});

describe('computeAllocationActions', () => {
  // ============================================================
  // Case 1: Fresh vault — no allocations yet
  // All 4 markets at 0, need to go from 0% → 5% each
  // ============================================================
  describe('fresh vault (zero allocations)', () => {
    it('allocates equally to all 4 markets', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [0n, 0n, 0n, 0n],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(4);

      for (const action of result.actions) {
        expect(action.action).toBe('allocate');
        expect(action.amount).toBe(eth('50')); // 5% of 1000
      }
    });

    it('produces correct market indices', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [0n, 0n, 0n, 0n],
      }));

      expect(result.actions.map(a => a.marketIndex)).toEqual([0, 1, 2, 3]);
    });
  });

  // ============================================================
  // Case 2: Partial allocation — some markets funded, some not
  // This was the actual bug: first run succeeded for 2 markets,
  // second run tried to add more to already-full markets
  // ============================================================
  describe('partial allocation (some markets at target, some at zero)', () => {
    it('only allocates to under-funded markets', () => {
      // stUSDS and wstETH at 5% already, cbBTC and WETH at 0%
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), 0n, eth('50'), 0n],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(2);

      // Only markets 1 (cbBTC) and 3 (WETH) should get allocations
      expect(result.actions[0]).toEqual({ marketIndex: 1, action: 'allocate', amount: eth('50') });
      expect(result.actions[1]).toEqual({ marketIndex: 3, action: 'allocate', amount: eth('50') });
    });

    it('allocates correct deficit when markets are partially funded', () => {
      // cbBTC and WETH at 2.5% (half target), rest at target
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), eth('25'), eth('50'), eth('25')],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0]).toEqual({ marketIndex: 1, action: 'allocate', amount: eth('25') });
      expect(result.actions[1]).toEqual({ marketIndex: 3, action: 'allocate', amount: eth('25') });
    });
  });

  // ============================================================
  // Case 3: All markets at target — no rebalancing needed
  // ============================================================
  describe('all markets at target', () => {
    it('skips when perfectly balanced', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), eth('50'), eth('50'), eth('50')],
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
      expect(result.actions).toHaveLength(0);
    });
  });

  // ============================================================
  // Case 4: Within threshold — small deviation, no action
  // ============================================================
  describe('within threshold', () => {
    it('skips when deviation is below 1%', () => {
      // 19.5% allocated (0.5% deviation < 1% threshold)
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), eth('50'), eth('50'), eth('45')],
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });

    it('acts when deviation equals threshold', () => {
      // 19% allocated (1% deviation = threshold, triggers rebalance)
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), eth('50'), eth('50'), eth('40')],
      }));

      // Deviation is exactly at threshold (not strictly less), so rebalance triggers
      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual({ marketIndex: 3, action: 'allocate', amount: eth('10') });
    });

    it('acts when deviation exceeds threshold', () => {
      // 18% allocated (2% deviation > 1% threshold)
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), eth('50'), eth('50'), eth('30')],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual({ marketIndex: 3, action: 'allocate', amount: eth('20') });
    });
  });

  // ============================================================
  // Case 5: Over-allocated — needs deallocation
  // ============================================================
  describe('over-allocated', () => {
    it('deallocates from over-funded markets', () => {
      // 30% total allocated, target 20%
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('75'), eth('75'), eth('75'), eth('75')],
      }));

      expect(result.skipped).toBe(false);
      for (const action of result.actions) {
        expect(action.action).toBe('deallocate');
        expect(action.amount).toBe(eth('25')); // 75 - 50 = 25 excess
      }
    });
  });

  // ============================================================
  // Case 6: Mixed — some markets over, some under
  // ============================================================
  describe('mixed over/under allocation', () => {
    it('allocates and deallocates per market', () => {
      // Total 18% (2% under), but distribution is uneven
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('80'), eth('10'), eth('80'), eth('10')],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(4);

      // Markets 0 and 2 over-allocated (80 > 50)
      expect(result.actions[0]).toEqual({ marketIndex: 0, action: 'deallocate', amount: eth('30') });
      expect(result.actions[2]).toEqual({ marketIndex: 2, action: 'deallocate', amount: eth('30') });

      // Markets 1 and 3 under-allocated (10 < 50)
      expect(result.actions[1]).toEqual({ marketIndex: 1, action: 'allocate', amount: eth('40') });
      expect(result.actions[3]).toEqual({ marketIndex: 3, action: 'allocate', amount: eth('40') });
    });
  });

  // ============================================================
  // Case 7: Tiny vault (dead deposit only, ~1 USDS)
  // The real-world scenario from our deployment
  // ============================================================
  describe('tiny vault (1 USDS dead deposit)', () => {
    it('allocates 5% per market', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1'),
        perMarketAssets: [0n, 0n, 0n, 0n],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(4);
      for (const action of result.actions) {
        expect(action.action).toBe('allocate');
        expect(action.amount).toBe(eth('0.05')); // 5% of 1
      }
    });

    it('reproduces the partial failure scenario', () => {
      // After first run: stUSDS and wstETH at 5%, cbBTC and WETH at 0%
      const result = computeAllocationActions(input({
        totalAssets: eth('1'),
        perMarketAssets: [eth('0.05'), 0n, eth('0.05'), 0n],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(2);

      // Only cbBTC (index 1) and WETH (index 3) need allocation
      expect(result.actions[0].marketIndex).toBe(1);
      expect(result.actions[0].action).toBe('allocate');
      expect(result.actions[0].amount).toBe(eth('0.05'));

      expect(result.actions[1].marketIndex).toBe(3);
      expect(result.actions[1].action).toBe('allocate');
      expect(result.actions[1].amount).toBe(eth('0.05'));
    });

    it('skips when all 4 markets are at 5%', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1'),
        perMarketAssets: [eth('0.05'), eth('0.05'), eth('0.05'), eth('0.05')],
      }));

      expect(result.skipped).toBe(true);
    });
  });

  // ============================================================
  // Case 8: Approximate amounts — caller re-reads fresh state
  // The allocation amounts from computeAllocationActions are approximate.
  // The caller (allocator.ts) re-reads fresh totalAssets and
  // expectedSupplyAssets before each allocation and uses
  // computeCapLimit() for the exact on-chain amount.
  // ============================================================
  describe('approximate allocations (exact amounts computed by caller)', () => {
    it('returns the raw deficit as allocation amount', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [0n],
        targetPerMarketBpsByIndex: [500],
      }));

      // Raw deficit — the caller will compute exact amount via computeCapLimit()
      expect(result.actions[0].amount).toBe(eth('50'));
    });

    it('deallocate amounts are exact (no cap check needed)', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('75')],
        targetPerMarketBpsByIndex: [500],
      }));

      expect(result.actions[0].amount).toBe(eth('25'));
    });
  });

  // ============================================================
  // Case: Per-market asymmetric targets (deallocation migration)
  // [stUSDS, cbBTC, wstETH, WETH] with targets [0%, 10%, 10%, 0%]
  // ============================================================
  describe('asymmetric per-market targets', () => {
    it('deallocates fully from markets with target 0 and grows others to their target', () => {
      // Starting from the 5/5/5/5 = 20% state, migrate to 0/10/10/0 = 20% state
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), eth('50'), eth('50'), eth('50')],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],  // 0%, 10%, 10%, 0%
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(4);

      // stUSDS: 50 → 0, deallocate 50
      expect(result.actions[0]).toEqual({ marketIndex: 0, action: 'deallocate', amount: eth('50') });
      // cbBTC: 50 → 100, allocate 50
      expect(result.actions[1]).toEqual({ marketIndex: 1, action: 'allocate', amount: eth('50') });
      // wstETH: 50 → 100, allocate 50
      expect(result.actions[2]).toEqual({ marketIndex: 2, action: 'allocate', amount: eth('50') });
      // WETH: 50 → 0, deallocate 50
      expect(result.actions[3]).toEqual({ marketIndex: 3, action: 'deallocate', amount: eth('50') });
    });

    it('emits only deallocate actions when retired markets are still funded but new markets are at target', () => {
      // Mid-migration: retired markets still have some allocation, cbBTC/wstETH already at 10%
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('10'), eth('100'), eth('100'), eth('10')],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0]).toEqual({ marketIndex: 0, action: 'deallocate', amount: eth('10') });
      expect(result.actions[1]).toEqual({ marketIndex: 3, action: 'deallocate', amount: eth('10') });
    });

    it('emits no actions when all 4 markets match asymmetric targets exactly', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [0n, eth('100'), eth('100'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });

    it('skips when target=0 market still has dust below threshold', () => {
      // stUSDS has 0.5 USDS dust (0.05% of 1000) — total deviation is 0.05%, below 1% threshold
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('0.5'), eth('100'), eth('100'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });

    // The production config uses rebalanceThresholdBps = 10 (0.1%), not the helper's
    // default of 100 (1%). Pin the migration decision to the real threshold so the
    // now-critical short-circuit is validated at the value the bot actually runs with.
    it('fires the full migration at the production threshold (10 bps)', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('50'), eth('50'), eth('50'), eth('50')],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,  // production value
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toEqual([
        { marketIndex: 0, action: 'deallocate', amount: eth('50') },
        { marketIndex: 1, action: 'allocate', amount: eth('50') },
        { marketIndex: 2, action: 'allocate', amount: eth('50') },
        { marketIndex: 3, action: 'deallocate', amount: eth('50') },
      ]);
    });

    it('at 10 bps, a sub-threshold dust market alone is skipped but rides along when another market triggers', () => {
      // Dust-only: stUSDS 0.5 USDS = 5 bps of 1000, below the 10 bps production threshold → skip.
      const dustOnly = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('0.5'), eth('100'), eth('100'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
      }));
      expect(dustOnly.skipped).toBe(true);

      // Same dust, but cbBTC is now far off target (50 bps) → the run fires AND the
      // 0.5 USDS deallocate from the target-0 market rides along. computeAllocationActions
      // emits it, and because stUSDS is a drain-to-zero market the bot does NOT dust-filter
      // it on-chain (shouldExecuteDeallocate exempts target=0), so it fully drains.
      const ridesAlong = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [eth('0.5'), eth('95'), eth('100'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
      }));
      expect(ridesAlong.skipped).toBe(false);
      expect(ridesAlong.actions).toEqual([
        { marketIndex: 0, action: 'deallocate', amount: eth('0.5') },
        { marketIndex: 1, action: 'allocate', amount: eth('5') },
      ]);
    });

    // ----- Dust sweep of retired (target-0) markets (minSweepAmount) -----
    // Vault of 100,000 so the 10 bps threshold maps to a clean 100 USDS boundary.

    it('sweeps a retired market holding residual above the sweep floor but below the bps threshold', () => {
      // stUSDS retired (target 0) holds 50 USDS = 5 bps of 100,000, below the 10 bps
      // threshold; grown markets are exactly at target (10% = 10,000 each). Without a
      // sweep floor this run would skip and strand the 50 USDS; minSweepAmount=10 fires it.
      const result = computeAllocationActions(input({
        totalAssets: eth('100000'),
        perMarketAssets: [eth('50'), eth('10000'), eth('10000'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
        minSweepAmount: eth('10'),
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toEqual([
        { marketIndex: 0, action: 'deallocate', amount: eth('50') },
      ]);
    });

    it('does NOT sweep when the retired market residual is below the sweep floor', () => {
      // 5 USDS residual, sweep floor 10 USDS, all else at target → genuine dust, left alone.
      const result = computeAllocationActions(input({
        totalAssets: eth('100000'),
        perMarketAssets: [eth('5'), eth('10000'), eth('10000'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
        minSweepAmount: eth('10'),
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });

    it('sweeps both retired markets when both hold sub-threshold residual', () => {
      // stUSDS and WETH both retired and holding 50 USDS each (5 bps), grown markets at target.
      const result = computeAllocationActions(input({
        totalAssets: eth('100000'),
        perMarketAssets: [eth('50'), eth('10000'), eth('10000'), eth('50')],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
        minSweepAmount: eth('10'),
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toEqual([
        { marketIndex: 0, action: 'deallocate', amount: eth('50') },
        { marketIndex: 3, action: 'deallocate', amount: eth('50') },
      ]);
    });

    it('sweep is disabled by default (minSweepAmount omitted → sub-threshold residual is left)', () => {
      // Same 50 USDS dust as the sweep test, but no minSweepAmount → behaves as before (skips).
      const result = computeAllocationActions(input({
        totalAssets: eth('100000'),
        perMarketAssets: [eth('50'), eth('10000'), eth('10000'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });

    it('sweep floor does not force a run for a sub-threshold market with a positive target', () => {
      // cbBTC is 50 USDS below its 10% target (5 bps, within threshold) — not retired,
      // so the sweep floor must not apply to it; with no other trigger the run skips.
      const result = computeAllocationActions(input({
        totalAssets: eth('100000'),
        perMarketAssets: [0n, eth('9950'), eth('10000'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
        minSweepAmount: eth('10'),
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });

    it('sweeps at the PRODUCTION floor (100 USDS) on a large vault, sub-threshold band', () => {
      // 20M vault, production threshold 10 bps = 20,000 USDS, production sweep floor 100 USDS.
      // A retired market holding 5,000 USDS is below threshold (2.5 bps) but well above the
      // 100 USDS floor → must be swept. Exercises the real production numbers, not eth('10').
      const result = computeAllocationActions(input({
        totalAssets: eth('20000000'),
        perMarketAssets: [eth('5000'), eth('2000000'), eth('2000000'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
        minSweepAmount: eth('100'),
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toEqual([
        { marketIndex: 0, action: 'deallocate', amount: eth('5000') },
      ]);
    });

    it('at the production floor, a residual below 100 USDS is left as dust', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('20000000'),
        perMarketAssets: [eth('50'), eth('2000000'), eth('2000000'), 0n],
        targetPerMarketBpsByIndex: [0, 1000, 1000, 0],
        rebalanceThresholdBps: 10,
        minSweepAmount: eth('100'),
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================
  describe('edge cases', () => {
    it('handles zero totalAssets', () => {
      const result = computeAllocationActions(input({
        totalAssets: 0n,
        perMarketAssets: [0n, 0n, 0n, 0n],
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('totalAssets is zero');
    });

    it('handles single market', () => {
      const result = computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [0n],
        targetPerMarketBpsByIndex: [500],
      }));

      expect(result.skipped).toBe(false);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual({ marketIndex: 0, action: 'allocate', amount: eth('50') });
    });

    it('throws when targetPerMarketBpsByIndex length does not match perMarketAssets', () => {
      expect(() => computeAllocationActions(input({
        totalAssets: eth('1000'),
        perMarketAssets: [0n, 0n, 0n, 0n],
        targetPerMarketBpsByIndex: [500, 500],  // 2 targets for 4 markets — should throw
      }))).toThrow(/targetPerMarketBpsByIndex length \(2\) must match perMarketAssets length \(4\)/);
    });

    it('handles interest accrual (market slightly above target)', () => {
      // After interest accrual, markets may be slightly above 5%
      const result = computeAllocationActions(input({
        totalAssets: eth('1000.5'),
        perMarketAssets: [
          eth('50.2'),  // slightly above due to interest
          eth('50.1'),
          eth('50.1'),
          eth('50.1'),
        ],
      }));

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('within threshold');
    });
  });
});

// ============================================================
// capDeallocationsToLiquidity
// ============================================================

describe('capDeallocationsToLiquidity', () => {
  // Helper: build a deallocate action
  function dealloc(marketIndex: number, amount: bigint): AllocationAction {
    return { marketIndex, action: 'deallocate', amount };
  }

  // Helper: build market liquidity data
  function liq(marketIndex: number, totalSupply: bigint, totalBorrow: bigint): MarketLiquidity {
    return { marketIndex, totalSupplyAssets: totalSupply, totalBorrowAssets: totalBorrow };
  }

  describe('happy path — plenty of liquidity', () => {
    it('passes through full amount when liquidity is abundant', () => {
      // Market has 10M supply, 5M borrow → 5M liquidity, reserve = 500K
      // Want to deallocate 1M → plenty of room
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('1000000'))],
        [liq(0, eth('10000000'), eth('5000000'))],
      );

      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(eth('1000000'));
      expect(result[0].capped).toBe(false);
      expect(result[0].skipped).toBe(false);
    });

    it('handles multiple markets with sufficient liquidity', () => {
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('100')), dealloc(1, eth('200')), dealloc(2, eth('300')), dealloc(3, eth('400'))],
        [
          liq(0, eth('10000'), eth('5000')),
          liq(1, eth('10000'), eth('5000')),
          liq(2, eth('10000'), eth('5000')),
          liq(3, eth('10000'), eth('5000')),
        ],
      );

      expect(result).toHaveLength(4);
      for (const r of result) {
        expect(r.capped).toBe(false);
        expect(r.skipped).toBe(false);
      }
      expect(result[0].amount).toBe(eth('100'));
      expect(result[1].amount).toBe(eth('200'));
      expect(result[2].amount).toBe(eth('300'));
      expect(result[3].amount).toBe(eth('400'));
    });
  });

  describe('capping — liquidity insufficient for full amount', () => {
    it('caps to maxWithdrawable when desired exceeds available after reserve', () => {
      // 2.6M supply, 2.47M borrow → 130K liquidity, reserve = 130K
      // maxWithdrawable = 130K - 130K = 0  ← this is the edge case from review!
      // Actually with 2.6M supply: reserve = 2.6M * 5% = 130K
      // liquidity = 130K, reserve = 130K → maxWithdrawable = 0 → skipped
      //
      // Let's use a case where capping actually applies:
      // 2M supply, 1.5M borrow → 500K liquidity, reserve = 100K
      // maxWithdrawable = 400K, want 1M → capped to 400K
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('1000000'))],
        [liq(0, eth('2000000'), eth('1500000'))],
      );

      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(eth('400000'));
      expect(result[0].capped).toBe(true);
      expect(result[0].skipped).toBe(false);
    });

    it('caps each market independently', () => {
      // Market 0: plenty of liquidity → not capped
      // Market 1: tight liquidity → capped
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('100')), dealloc(1, eth('100'))],
        [
          liq(0, eth('10000'), eth('5000')),     // 5000 liquidity, 500 reserve → 4500 available
          liq(1, eth('1000'), eth('900')),        // 100 liquidity, 50 reserve → 50 available
        ],
      );

      expect(result[0].amount).toBe(eth('100'));
      expect(result[0].capped).toBe(false);
      expect(result[1].amount).toBe(eth('50'));
      expect(result[1].capped).toBe(true);
    });
  });

  describe('skipping — no withdrawable liquidity', () => {
    it('skips when market is at 100% utilization', () => {
      // 2M supply, 2M borrow → 0 liquidity
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('1000000'))],
        [liq(0, eth('2000000'), eth('2000000'))],
      );

      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(0n);
      expect(result[0].skipped).toBe(true);
      expect(result[0].availableLiquidity).toBe(0n);
    });

    it('skips when liquidity equals the reserve (edge case)', () => {
      // 2M supply, 1.9M borrow → 100K liquidity, reserve = 100K
      // maxWithdrawable = 100K - 100K = 0 → skipped
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('500000'))],
        [liq(0, eth('2000000'), eth('1900000'))],
      );

      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(0n);
      expect(result[0].skipped).toBe(true);
      expect(result[0].availableLiquidity).toBe(eth('100000'));
    });

    it('skips when liquidity is below the reserve', () => {
      // 2M supply, 1.95M borrow → 50K liquidity, reserve = 100K
      // maxWithdrawable = 0 (liquidity < reserve)
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('500000'))],
        [liq(0, eth('2000000'), eth('1950000'))],
      );

      expect(result).toHaveLength(1);
      expect(result[0].skipped).toBe(true);
    });

    it('skips when no liquidity data is provided for a market', () => {
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('100'))],
        [], // no liquidity data
      );

      expect(result).toHaveLength(1);
      expect(result[0].skipped).toBe(true);
      expect(result[0].amount).toBe(0n);
    });

    it('handles all markets skipped', () => {
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('100')), dealloc(1, eth('200'))],
        [
          liq(0, eth('1000'), eth('1000')),  // 100% utilization
          liq(1, eth('1000'), eth('1000')),  // 100% utilization
        ],
      );

      expect(result).toHaveLength(2);
      expect(result.every(r => r.skipped)).toBe(true);
    });
  });

  describe('mixed — some markets capped, some not, some skipped', () => {
    it('handles realistic 4-market scenario', () => {
      // Market 0: plenty of liquidity
      // Market 1: needs capping
      // Market 2: fully utilized (skip)
      // Market 3: liquidity exactly at reserve (skip)
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('1000')), dealloc(1, eth('1000')), dealloc(2, eth('1000')), dealloc(3, eth('1000'))],
        [
          liq(0, eth('100000'), eth('50000')),   // 50K liquidity, 5K reserve → 45K avail
          liq(1, eth('10000'), eth('9000')),      // 1K liquidity, 500 reserve → 500 avail
          liq(2, eth('10000'), eth('10000')),     // 0 liquidity
          liq(3, eth('10000'), eth('9500')),      // 500 liquidity, 500 reserve → 0 avail
        ],
      );

      expect(result).toHaveLength(4);

      // Market 0: full amount, not capped
      expect(result[0].amount).toBe(eth('1000'));
      expect(result[0].capped).toBe(false);
      expect(result[0].skipped).toBe(false);

      // Market 1: capped to 500
      expect(result[1].amount).toBe(eth('500'));
      expect(result[1].capped).toBe(true);
      expect(result[1].skipped).toBe(false);

      // Market 2: skipped (no liquidity)
      expect(result[2].skipped).toBe(true);

      // Market 3: skipped (liquidity equals reserve)
      expect(result[3].skipped).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty actions list', () => {
      const result = capDeallocationsToLiquidity([], []);
      expect(result).toHaveLength(0);
    });

    it('handles zero supply market (should not happen but be safe)', () => {
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('100'))],
        [liq(0, 0n, 0n)],
      );

      expect(result).toHaveLength(1);
      expect(result[0].skipped).toBe(true);
      expect(result[0].availableLiquidity).toBe(0n);
    });

    it('handles borrow exceeding supply (should not happen on-chain)', () => {
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('100'))],
        [liq(0, eth('1000'), eth('1500'))],
      );

      expect(result).toHaveLength(1);
      expect(result[0].skipped).toBe(true);
      expect(result[0].availableLiquidity).toBe(0n);
    });

    it('returns exact amount when desired equals maxWithdrawable', () => {
      // 10M supply, 5M borrow → 5M liquidity, reserve = 500K
      // maxWithdrawable = 4.5M, want exactly 4.5M
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('4500000'))],
        [liq(0, eth('10000000'), eth('5000000'))],
      );

      expect(result[0].amount).toBe(eth('4500000'));
      expect(result[0].capped).toBe(false);
      expect(result[0].skipped).toBe(false);
    });

    it('caps when desired is 1 wei above maxWithdrawable', () => {
      // maxWithdrawable = 4.5M, want 4.5M + 1 wei
      const result = capDeallocationsToLiquidity(
        [dealloc(0, eth('4500000') + 1n)],
        [liq(0, eth('10000000'), eth('5000000'))],
      );

      expect(result[0].amount).toBe(eth('4500000'));
      expect(result[0].capped).toBe(true);
    });

    it('preserves market indices in output', () => {
      // Non-contiguous indices (markets 1 and 3 only)
      const result = capDeallocationsToLiquidity(
        [dealloc(1, eth('100')), dealloc(3, eth('200'))],
        [liq(1, eth('10000'), eth('5000')), liq(3, eth('10000'), eth('5000'))],
      );

      expect(result[0].marketIndex).toBe(1);
      expect(result[1].marketIndex).toBe(3);
    });
  });

  describe('reserve constant', () => {
    it('LIQUIDITY_RESERVE_PERCENT defaults to 5 (override via env)', () => {
      // Default when env var is unset (vitest runs without LIQUIDITY_RESERVE_PERCENT set)
      expect(LIQUIDITY_RESERVE_PERCENT).toBe(5n);
    });

    it('reserve math: 5% of 2.6M = 130K', () => {
      const totalSupply = eth('2600000');
      const reserve = totalSupply * LIQUIDITY_RESERVE_PERCENT / 100n;
      expect(reserve).toBe(eth('130000'));
    });
  });
});

// ============================================================
// parseTargetBps — env-value parsing for per-market targets
// ============================================================
describe('parseTargetBps', () => {
  it('returns the default only when the value is unset (undefined)', () => {
    expect(parseTargetBps(undefined, 500, 'TARGET_X_BPS')).toBe(500);
  });

  it('parses a valid whole number of basis points', () => {
    expect(parseTargetBps('0', 500, 'TARGET_X_BPS')).toBe(0);
    expect(parseTargetBps('1000', 500, 'TARGET_X_BPS')).toBe(1000);
    expect(parseTargetBps('10000', 500, 'TARGET_X_BPS')).toBe(10000);
  });

  it('tolerates surrounding whitespace around a valid value', () => {
    expect(parseTargetBps('  1000  ', 500, 'TARGET_X_BPS')).toBe(1000);
  });

  it('throws on empty string instead of silently coercing to 0', () => {
    expect(() => parseTargetBps('', 500, 'TARGET_X_BPS')).toThrow(/TARGET_X_BPS/);
  });

  it('throws on whitespace-only string', () => {
    expect(() => parseTargetBps('   ', 500, 'TARGET_X_BPS')).toThrow(/TARGET_X_BPS/);
  });

  it('throws on non-numeric values', () => {
    expect(() => parseTargetBps('abc', 500, 'TARGET_X_BPS')).toThrow();
  });

  it('throws on negative values', () => {
    expect(() => parseTargetBps('-100', 500, 'TARGET_X_BPS')).toThrow();
  });

  it('throws on decimals', () => {
    expect(() => parseTargetBps('5.5', 500, 'TARGET_X_BPS')).toThrow();
  });

  it('throws on non-decimal forms (hex, exponential)', () => {
    expect(() => parseTargetBps('0x10', 500, 'TARGET_X_BPS')).toThrow();
    expect(() => parseTargetBps('1e3', 500, 'TARGET_X_BPS')).toThrow();
  });

  it('throws when above 10000 bps (100%)', () => {
    expect(() => parseTargetBps('10001', 500, 'TARGET_X_BPS')).toThrow(/<= 10000/);
  });
});

// ============================================================
// validateTargetBpsSum — strategy invariant enforcement
// ============================================================
describe('validateTargetBpsSum', () => {
  it('passes when targets sum to the expected total (legacy 5/5/5/5)', () => {
    expect(() => validateTargetBpsSum(
      [{ label: 'a', bps: 500 }, { label: 'b', bps: 500 }, { label: 'c', bps: 500 }, { label: 'd', bps: 500 }],
      2000,
    )).not.toThrow();
  });

  it('passes for the asymmetric migration targets (0/10/10/0)', () => {
    expect(() => validateTargetBpsSum(
      [{ label: 'stUSDS', bps: 0 }, { label: 'cbBTC', bps: 1000 }, { label: 'wstETH', bps: 1000 }, { label: 'WETH', bps: 0 }],
      2000,
    )).not.toThrow();
  });

  it('throws when the sum is below target (e.g. a forgotten override)', () => {
    expect(() => validateTargetBpsSum(
      [{ label: 'stUSDS', bps: 0 }, { label: 'cbBTC', bps: 1000 }, { label: 'wstETH', bps: 500 }, { label: 'WETH', bps: 0 }],
      2000,
    )).toThrow(/1500.*must equal.*2000/);
  });

  it('throws when the sum is above target', () => {
    expect(() => validateTargetBpsSum(
      [{ label: 'a', bps: 1000 }, { label: 'b', bps: 1000 }, { label: 'c', bps: 1000 }],
      2000,
    )).toThrow(/3000.*must equal.*2000/);
  });
});

// ============================================================
// shouldExecuteDeallocate — dust filter that never blocks drain-to-zero
// ============================================================
describe('shouldExecuteDeallocate', () => {
  const MIN = eth('100');

  it('always executes for a drain-to-zero market (target 0), even sub-floor', () => {
    // The migration's whole point: a retiring market must fully empty, not strand dust.
    expect(shouldExecuteDeallocate(eth('50'), 0, MIN)).toBe(true);
    expect(shouldExecuteDeallocate(1n, 0, MIN)).toBe(true);
  });

  it('judges non-zero-target trims by the desired amount vs the floor', () => {
    expect(shouldExecuteDeallocate(eth('500'), 500, MIN)).toBe(true);   // real trim
    expect(shouldExecuteDeallocate(eth('50'), 500, MIN)).toBe(false);   // dust trim → skip
    expect(shouldExecuteDeallocate(eth('100'), 500, MIN)).toBe(true);   // exactly at floor
  });

  it('drain-to-zero exemption is independent of the (pre-cap) desired amount', () => {
    // Even a large desired drain that liquidity would cap small still passes here,
    // because the dust decision is made on the desired amount and target=0 is exempt.
    expect(shouldExecuteDeallocate(eth('100000'), 0, MIN)).toBe(true);
  });
});

// ============================================================
// planDeallocations — composition of liquidity skip + dust filter
// ============================================================
describe('planDeallocations', () => {
  const MIN = eth('100');
  const item = (o: Partial<DeallocatePlanItem> & Pick<DeallocatePlanItem, 'marketIndex' | 'targetBps' | 'desired' | 'cappedAmount'>): DeallocatePlanItem => ({
    capped: false, skipped: false, availableLiquidity: eth('1000000'), ...o,
  });

  it('executes a normal drain', () => {
    const out = planDeallocations([item({ marketIndex: 0, targetBps: 0, desired: eth('500'), cappedAmount: eth('500') })], MIN);
    expect(out).toEqual([{ marketIndex: 0, status: 'execute', amount: eth('500'), capped: false, availableLiquidity: eth('1000000') }]);
  });

  it('skips liquidity-starved markets', () => {
    const out = planDeallocations([item({ marketIndex: 1, targetBps: 0, desired: eth('500'), cappedAmount: 0n, skipped: true, availableLiquidity: 0n })], MIN);
    expect(out[0].status).toBe('skip-liquidity');
  });

  it('liquidity-limited drain of a retired market still executes the capped slice (not dropped as dust)', () => {
    // The key regression guard: desired 500 (≥ floor and target-0), liquidity caps to 50.
    // Dust decision is on `desired` (500), not the capped 50, so it executes incremental progress.
    const out = planDeallocations([item({ marketIndex: 3, targetBps: 0, desired: eth('500'), cappedAmount: eth('50'), capped: true, availableLiquidity: eth('50') })], MIN);
    expect(out).toEqual([{ marketIndex: 3, status: 'execute', amount: eth('50'), capped: true, availableLiquidity: eth('50') }]);
  });

  it('drain-to-zero executes even when the full residual is below the floor', () => {
    const out = planDeallocations([item({ marketIndex: 0, targetBps: 0, desired: eth('5'), cappedAmount: eth('5') })], MIN);
    expect(out[0]).toMatchObject({ status: 'execute', amount: eth('5') });
  });

  it('suppresses a sub-floor trim on a non-retired market', () => {
    const out = planDeallocations([item({ marketIndex: 1, targetBps: 500, desired: eth('50'), cappedAmount: eth('50') })], MIN);
    expect(out[0]).toEqual({ marketIndex: 1, status: 'skip-dust', desired: eth('50') });
  });

  it('preserves order across mixed outcomes', () => {
    const out = planDeallocations([
      item({ marketIndex: 0, targetBps: 0, desired: eth('500'), cappedAmount: eth('500') }),
      item({ marketIndex: 1, targetBps: 500, desired: eth('50'), cappedAmount: eth('50') }),
      item({ marketIndex: 3, targetBps: 0, desired: eth('300'), cappedAmount: 0n, skipped: true, availableLiquidity: 0n }),
    ], MIN);
    expect(out.map(o => o.status)).toEqual(['execute', 'skip-dust', 'skip-liquidity']);
  });
});

// ============================================================
// planAllocations — gap-to-cap with dust floor and at-cap distinction
// ============================================================
describe('planAllocations', () => {
  const MIN = eth('100');
  const item = (marketIndex: number, effectiveCap: bigint, freshExpected: bigint): AllocatePlanItem => ({ marketIndex, effectiveCap, freshExpected });

  it('executes the gap to the effective cap when above the floor', () => {
    expect(planAllocations([item(1, eth('1400'), eth('1000'))], MIN)).toEqual([{ marketIndex: 1, status: 'execute', amount: eth('400') }]);
  });

  it('marks already-at-cap as skip-atcap (routine, silent)', () => {
    expect(planAllocations([item(1, eth('1400'), eth('1400'))], MIN)).toEqual([{ marketIndex: 1, status: 'skip-atcap' }]);
    expect(planAllocations([item(1, eth('1400'), eth('1500'))], MIN)).toEqual([{ marketIndex: 1, status: 'skip-atcap' }]);
  });

  it('marks a sub-floor gap as skip-dust (worth logging)', () => {
    expect(planAllocations([item(2, eth('1400'), eth('1350'))], MIN)).toEqual([{ marketIndex: 2, status: 'skip-dust', gap: eth('50') }]);
  });

  it('a grown market sitting 1 bps under cap (headroom) is skip-atcap, not a dust log', () => {
    // effectiveCap == freshExpected (market already at the clamped cap) → routine no-op.
    expect(planAllocations([item(1, eth('2000000'), eth('2000000'))], MIN)).toEqual([{ marketIndex: 1, status: 'skip-atcap' }]);
  });
});

// ============================================================
// computeAllocationBudget — room under the aggregate adapter cap after deallocations
// ============================================================
describe('computeAllocationBudget', () => {
  it('returns the room under the cap after deallocations', () => {
    // adapter 200 now, cap 210, deallocate 30 → after = 170, budget = 40
    expect(computeAllocationBudget(eth('210'), eth('200'), eth('30'))).toBe(eth('40'));
  });

  it('returns 0 when the adapter is already at/over cap and deallocations do not bring it under', () => {
    // adapter 220 now (over cap 210), deallocate 5 → after = 215 > cap → budget 0
    expect(computeAllocationBudget(eth('210'), eth('220'), eth('5'))).toBe(0n);
  });

  it('returns 0 exactly at the cap (no room)', () => {
    expect(computeAllocationBudget(eth('210'), eth('210'), 0n)).toBe(0n);
  });

  it('reproduces the incident: over-cap adapter, partial drain → small positive budget', () => {
    // From the live revert: adapter cap ~8,205,693 (20% w/ headroom), adapter 8,995,571,
    // deallocated 1,317,750 → after ~7,677,821 → budget ~527,872 (not the 3.94M it tried).
    const budget = computeAllocationBudget(
      eth('8205692.812'),
      eth('8995570.813448031967940668'),
      eth('1317749.962128748417536743'),
    );
    expect(budget).toBeGreaterThan(eth('527000'));
    expect(budget).toBeLessThan(eth('528000'));
  });
});

// ============================================================
// capAllocationsToBudget — constrain total allocations to the aggregate adapter cap
// ============================================================
describe('capAllocationsToBudget', () => {
  const MIN = eth('100');

  it('passes allocations through unchanged when they fit the budget', () => {
    const allocs = [{ marketIndex: 1, amount: eth('300') }, { marketIndex: 2, amount: eth('200') }];
    expect(capAllocationsToBudget(allocs, eth('1000'), MIN)).toEqual(allocs);
  });

  it('returns nothing when the budget is zero or negative (adapter at/over cap)', () => {
    const allocs = [{ marketIndex: 1, amount: eth('300') }];
    expect(capAllocationsToBudget(allocs, 0n, MIN)).toEqual([]);
    expect(capAllocationsToBudget(allocs, -5n, MIN)).toEqual([]);
  });

  it('scales allocations proportionally to fit the budget', () => {
    // Reproduces the revert scenario: wanted ~3.94M, budget ~0.53M.
    // cbBTC 1,994,052.55 and wstETH 1,950,187.18 → total 3,944,239.73; budget 527,874.
    const allocs = [
      { marketIndex: 1, amount: eth('1994052.554769614499589676') },
      { marketIndex: 2, amount: eth('1950187.180984754322095547') },
    ];
    const budget = eth('527874');
    const out = capAllocationsToBudget(allocs, budget, MIN);
    const total = out.reduce((s, a) => s + a.amount, 0n);
    // Scaled total never exceeds the budget (this is what keeps the adapter under its cap).
    expect(total).toBeLessThanOrEqual(budget);
    // Proportions preserved: cbBTC was slightly larger, so it stays slightly larger.
    expect(out[0].amount).toBeGreaterThan(out[1].amount);
    // Each market got a meaningful share (~half the budget), not zero.
    expect(out[0].amount).toBeGreaterThan(eth('260000'));
    expect(out[1].amount).toBeGreaterThan(eth('260000'));
  });

  it('drops a scaled-down allocation that falls below the dust floor', () => {
    // One huge market dominates the budget; the tiny one scales below MIN and is dropped.
    const allocs = [
      { marketIndex: 1, amount: eth('1000000') },
      { marketIndex: 2, amount: eth('100') },
    ];
    const out = capAllocationsToBudget(allocs, eth('500'), MIN);
    expect(out.map(a => a.marketIndex)).toEqual([1]);
    expect(out[0].amount).toBeLessThanOrEqual(eth('500'));
  });
});
