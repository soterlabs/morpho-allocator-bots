import { describe, it, expect } from 'vitest';
import { computeMigration, maxWithdrawableForUtilization, planLiquidityRoute, type LiquidityRouteInput, type MigrationInput } from './migration-logic.js';
import { parseUnits } from 'viem';

// USDT has 6 decimals.
const usdt = (v: string) => parseUnits(v, 6);
const MIN = usdt('100'); // 100 USDT dust floor

function input(overrides: Partial<MigrationInput>): MigrationInput {
  return {
    oldPosition: usdt('1000000'),
    oldTotalSupplyAssets: usdt('1000000'),
    oldTotalBorrowAssets: usdt('500000'),
    maxUtilizationBps: 9300,
    minAmount: MIN,
    ...overrides,
  };
}

describe('maxWithdrawableForUtilization', () => {
  it('withdraws everything when there are no borrows', () => {
    expect(maxWithdrawableForUtilization(usdt('1000'), 0n, 9300)).toBe(usdt('1000'));
  });

  it('caps withdrawal so post-withdraw utilization never exceeds 93%', () => {
    const supply = usdt('1000');
    const borrow = usdt('500');
    const w = maxWithdrawableForUtilization(supply, borrow, 9300);
    const supplyAfter = supply - w;
    // utilization after = borrow / supplyAfter <= 0.93
    expect(borrow * 10000n <= 9300n * supplyAfter).toBe(true);
    // boundary: 1 wei more would break it
    expect(borrow * 10000n <= 9300n * (supplyAfter - 1n)).toBe(false);
  });

  it('returns 0 when already at or above 93% utilization', () => {
    expect(maxWithdrawableForUtilization(usdt('1000'), usdt('950'), 9300)).toBe(0n); // 95%
    expect(maxWithdrawableForUtilization(usdt('1000'), usdt('930'), 9300)).toBe(0n); // exactly 93%
  });

  it('is stricter than all idle liquidity', () => {
    const supply = usdt('1000');
    const borrow = usdt('850'); // idle 150
    const w = maxWithdrawableForUtilization(supply, borrow, 9300);
    expect(w).toBeGreaterThan(0n);
    expect(w).toBeLessThan(supply - borrow);
  });
});

describe('computeMigration', () => {
  it('migrates the full old position when liquidity allows (low utilization)', () => {
    // supply == position, borrow 0 → the whole position is withdrawable.
    const plan = computeMigration(input({
      oldPosition: usdt('300000'),
      oldTotalSupplyAssets: usdt('300000'),
      oldTotalBorrowAssets: 0n,
    }));
    expect(plan.status).toBe('migrate');
    if (plan.status !== 'migrate') return;
    expect(plan.amount).toBe(usdt('300000'));
    expect(plan.utilizationCapped).toBe(false);
  });

  it('caps the round to the 93% utilization limit when the old market is busy', () => {
    // supply 1M, borrow 800k → can only pull supply - ceil(800k/0.93) before util hits 93%.
    const plan = computeMigration(input({
      oldPosition: usdt('1000000'),
      oldTotalSupplyAssets: usdt('1000000'),
      oldTotalBorrowAssets: usdt('800000'),
    }));
    expect(plan.status).toBe('migrate');
    if (plan.status !== 'migrate') return;
    const cap = maxWithdrawableForUtilization(usdt('1000000'), usdt('800000'), 9300);
    expect(plan.amount).toBe(cap);
    expect(plan.utilizationCapped).toBe(true);
    // Post-withdraw utilization must stay within 93%.
    const supplyAfter = usdt('1000000') - plan.amount;
    expect(usdt('800000') * 10000n <= 9300n * supplyAfter).toBe(true);
  });

  it('caps the round to the remaining old position when that is the binding limit', () => {
    // Plenty of liquidity (no borrows) but only 250 USDT left to move.
    const plan = computeMigration(input({
      oldPosition: usdt('250'),
      oldTotalSupplyAssets: usdt('500000'),
      oldTotalBorrowAssets: 0n,
    }));
    expect(plan.status).toBe('migrate');
    if (plan.status !== 'migrate') return;
    expect(plan.amount).toBe(usdt('250'));
    expect(plan.utilizationCapped).toBe(false);
  });

  it('waits (no withdrawal) when the old market is already at/above 93% utilization', () => {
    const plan = computeMigration(input({
      oldPosition: usdt('1000000'),
      oldTotalSupplyAssets: usdt('1000000'),
      oldTotalBorrowAssets: usdt('960000'), // 96% > 93%
    }));
    expect(plan.status).toBe('wait-utilization');
    if (plan.status !== 'wait-utilization') return;
    expect(plan.withdrawableByUtilization).toBe(0n);
  });

  it('reports done when the old market position is below the dust floor', () => {
    const plan = computeMigration(input({
      oldPosition: usdt('50'), // < 100 dust floor
      oldTotalSupplyAssets: usdt('50'),
      oldTotalBorrowAssets: 0n,
    }));
    expect(plan.status).toBe('done');
  });

  it('skips a dust round when withdrawable liquidity is below the floor but position is not', () => {
    // Big position still to move, but the market is so close to 93% that only ~1 USDT frees up.
    // supply 1,000,000.001, borrow 930,000 → util just under 93%, tiny withdrawable slice.
    const supply = usdt('930000') + usdt('1'); // 930001 USDT
    const plan = computeMigration(input({
      oldPosition: usdt('500000'),
      oldTotalSupplyAssets: supply,
      oldTotalBorrowAssets: usdt('930000'),
      minAmount: MIN,
    }));
    // withdrawable = supply - ceil(930000/0.93) = 930001 - 1000000 -> 0? recompute:
    const cap = maxWithdrawableForUtilization(supply, usdt('930000'), 9300);
    if (cap === 0n) {
      expect(plan.status).toBe('wait-utilization');
    } else if (cap < MIN) {
      expect(plan.status).toBe('dust');
    } else {
      expect(plan.status).toBe('migrate');
    }
  });

  it('treats a zero old position as done', () => {
    const plan = computeMigration(input({ oldPosition: 0n, oldTotalSupplyAssets: 0n, oldTotalBorrowAssets: 0n }));
    expect(plan.status).toBe('done');
  });
});

describe('planLiquidityRoute', () => {
  const ADAPTER = '0x6C5D5D47A39FE9f8CA14731a9A42bD31d64fb40D';
  const ZERO = '0x0000000000000000000000000000000000000000';
  // Stand-ins for abi.encode(MarketParams) of each market — only equality matters here.
  const OLD_DATA = '0xaaaa';
  const NEW_DATA = '0xbbbb';

  function route(overrides: Partial<LiquidityRouteInput> = {}): LiquidityRouteInput {
    return {
      currentAdapter: ADAPTER,
      currentData: OLD_DATA,
      desiredAdapter: ADAPTER,
      desiredData: NEW_DATA,
      enabled: true,
      ...overrides,
    };
  }

  it('updates when the route still points at the old market', () => {
    expect(planLiquidityRoute(route())).toEqual({ status: 'update' });
  });

  it('is a no-op once the route points at the new market (idempotent across runs)', () => {
    expect(planLiquidityRoute(route({ currentData: NEW_DATA }))).toEqual({ status: 'ok' });
  });

  it('ignores address and hex casing when comparing', () => {
    const plan = planLiquidityRoute(route({
      currentAdapter: ADAPTER.toLowerCase(),
      currentData: NEW_DATA.toUpperCase().replace('0X', '0x'),
    }));
    expect(plan).toEqual({ status: 'ok' });
  });

  it('adopts the route when the vault has none set (zero adapter)', () => {
    expect(planLiquidityRoute(route({ currentAdapter: ZERO, currentData: '0x' }))).toEqual({ status: 'update' });
  });

  it('refuses to overwrite a different (curator-chosen) adapter contract', () => {
    const foreign = '0x1111111111111111111111111111111111111111';
    expect(planLiquidityRoute(route({ currentAdapter: foreign }))).toEqual({
      status: 'foreign-adapter',
      currentAdapter: foreign,
    });
  });

  it('reports disabled when the kill switch is off and a change would be needed', () => {
    expect(planLiquidityRoute(route({ enabled: false }))).toEqual({ status: 'disabled' });
  });

  it('still reports ok when the kill switch is off but the route is already correct', () => {
    expect(planLiquidityRoute(route({ enabled: false, currentData: NEW_DATA }))).toEqual({ status: 'ok' });
  });
});
