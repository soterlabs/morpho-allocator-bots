import { describe, it, expect } from 'vitest';
import { parseEther, type Address } from 'viem';
import { bandsCaps, isDrainToZero, toReconcileMarket } from './band-plan.js';
import { parseBandConfig } from './band-config.js';
import type { BandDecision, MarketObservation } from './band-controller.js';
import type { MarketConfig } from './market-config.js';

// Defaults: minBandActionUsds 10k, minPriorityWithdrawalUsds 50k, plus 1M step caps.
const cfg = parseBandConfig({ MAX_ALLOCATE_USDS: '1000000', MAX_DEALLOCATE_USDS: '1000000' });

const TOTAL_ASSETS = parseEther('40400000');
// The vault's on-chain relative cap for the collateral: 10% of totalAssets.
const RELATIVE_CAP_10_PERCENT_WAD = 10n ** 17n;
// 10% of 40.4M = 4.04M, minus the 1 bps allocate headroom (404 USDS).
const ONCHAIN_BOUND = parseEther('4039596');

/** PT-sUSDS/USDS-shaped market: 100M absolute cap so only the 100% share cap matters. */
function marketConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return {
    name: 'PT-sUSDS/USDS',
    collateral: '0xdC169AbE56461A2E0c034Da431Ac2a3ebf596094' as Address,
    oracle: '0xda5901EF31ecAFa6561B2e56B4997FAdd3dB4646' as Address,
    lltv: 915000000000000000n,
    targetBps: 0,
    mode: 'PRIMARY',
    capUsds: parseEther('100000000'),
    capBps: 10000,
    ...overrides,
  };
}

/** cbBTC/USDS-like pool: 4.2M supply, 3.72M borrow, the vault holding 4.1M. */
function observation(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    index: 1,
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

/** A band-93 drain of 300k from the 4.1M position. */
function decision(overrides: Partial<BandDecision> = {}): BandDecision {
  return {
    index: 1,
    targetAmount: parseEther('3800000'),
    bandUtilBps: 9300,
    priority: false,
    rule: 'R-BAND93',
    reasons: [],
    ...overrides,
  };
}

describe('bandsCaps', () => {
  it('lets the on-chain relative cap (with 1 bps headroom) bound deposits when it is below the env cap', () => {
    const caps = bandsCaps(marketConfig(), TOTAL_ASSETS, RELATIVE_CAP_10_PERCENT_WAD);
    expect(caps.marketCap).toBe(parseEther('40400000'));
    expect(caps.effectiveCap).toBe(ONCHAIN_BOUND);
  });

  it('lets the env cap bound deposits when it is below the on-chain relative cap', () => {
    const caps = bandsCaps(marketConfig({ capUsds: parseEther('3000000') }), TOTAL_ASSETS, RELATIVE_CAP_10_PERCENT_WAD);
    expect(caps.marketCap).toBe(parseEther('3000000'));
    expect(caps.effectiveCap).toBe(parseEther('3000000'));
  });

  it('reports marketCap = min(capUsds, capBps x totalAssets) when the share binds', () => {
    const caps = bandsCaps(marketConfig({ capUsds: parseEther('5000000'), capBps: 1000 }), TOTAL_ASSETS, RELATIVE_CAP_10_PERCENT_WAD);
    expect(caps.marketCap).toBe(parseEther('4040000'));
    expect(caps.effectiveCap).toBe(ONCHAIN_BOUND);
  });

  it('leaves a RETIRED market without caps at the on-chain bound only', () => {
    const retired = marketConfig({ name: 'stUSDS/USDS', mode: 'RETIRED', capUsds: undefined, capBps: undefined });
    const caps = bandsCaps(retired, TOTAL_ASSETS, RELATIVE_CAP_10_PERCENT_WAD);
    expect(caps.marketCap).toBeUndefined();
    expect(caps.effectiveCap).toBe(ONCHAIN_BOUND);
  });
});

describe('toReconcileMarket', () => {
  it('carries the wish as delta = target - position with the pool state and band', () => {
    const wish = toReconcileMarket(marketConfig({ name: 'cbBTC/USDS', mode: 'STEERED' }), observation(), decision(), cfg);
    expect(wish).toEqual({
      index: 1,
      name: 'cbBTC/USDS',
      delta: parseEther('-300000'),
      priority: false,
      primary: false,
      bandUtilBps: 9300,
      minActionUsds: undefined,
      totalSupplyAssets: parseEther('4200000'),
      totalBorrowAssets: parseEther('3720000'),
      anchorApy: 0.023,
    });
  });

  it('flags the PRIMARY market as primary', () => {
    const wish = toReconcileMarket(marketConfig({ mode: 'PRIMARY' }), observation(), decision(), cfg);
    expect(wish.primary).toBe(true);
  });

  it('does not flag a STEERED market as primary', () => {
    const wish = toReconcileMarket(marketConfig({ name: 'cbBTC/USDS', mode: 'STEERED' }), observation(), decision(), cfg);
    expect(wish.primary).toBe(false);
  });

  it('copies the priority flag of a priority deposit', () => {
    const deposit = decision({ targetAmount: parseEther('5000000'), bandUtilBps: undefined, priority: true, rule: 'R-PRIORITY-DEPOSIT' });
    const wish = toReconcileMarket(marketConfig(), observation(), deposit, cfg);
    expect(wish.priority).toBe(true);
    expect(wish.delta).toBe(parseEther('900000'));
    expect(wish.bandUtilBps).toBeUndefined();
  });

  it('sets minPriorityWithdrawalUsds as the drop threshold of a priority withdrawal', () => {
    const breach = decision({ targetAmount: parseEther('4000000'), bandUtilBps: undefined, priority: true, rule: 'R-PRIORITY-WITHDRAWAL' });
    const wish = toReconcileMarket(marketConfig(), observation({ marketCap: parseEther('4000000') }), breach, cfg);
    expect(wish.minActionUsds).toBe(parseEther('50000'));
    expect(wish.priority).toBe(true);
  });

  it('keeps minPriorityWithdrawalUsds on a zero-cap drain larger than it', () => {
    // A 4.1M drain to zero: a floor cut leaving less than 50k of it is not worth a tx.
    const breach = decision({ targetAmount: 0n, bandUtilBps: undefined, priority: true, rule: 'R-PRIORITY-WITHDRAWAL' });
    const wish = toReconcileMarket(marketConfig(), observation({ marketCap: 0n }), breach, cfg);
    expect(wish.minActionUsds).toBe(parseEther('50000'));
  });

  it('lets a zero-cap drain smaller than minPriorityWithdrawalUsds pass as a whole', () => {
    // 30k left in a market that must hold nothing: the whole wish is the threshold,
    // so it survives the drop while any partial cut of it does not.
    const breach = decision({ targetAmount: 0n, bandUtilBps: undefined, priority: true, rule: 'R-PRIORITY-WITHDRAWAL' });
    const wish = toReconcileMarket(marketConfig(), observation({ marketCap: 0n, vaultAssets: parseEther('30000') }), breach, cfg);
    expect(wish.minActionUsds).toBe(parseEther('30000'));
  });

  it('leaves the threshold to the global min action for a steering wish', () => {
    const wish = toReconcileMarket(marketConfig(), observation(), decision(), cfg);
    expect(wish.minActionUsds).toBeUndefined();
  });

  it('leaves the threshold to the global min action for a priority deposit', () => {
    const deposit = decision({ targetAmount: parseEther('5000000'), bandUtilBps: undefined, priority: true, rule: 'R-PRIORITY-DEPOSIT' });
    const wish = toReconcileMarket(marketConfig(), observation(), deposit, cfg);
    expect(wish.minActionUsds).toBeUndefined();
  });
});

describe('isDrainToZero', () => {
  it('is true for a priority withdrawal of a zero-cap market', () => {
    const breach = decision({ targetAmount: 0n, bandUtilBps: undefined, priority: true, rule: 'R-PRIORITY-WITHDRAWAL' });
    expect(isDrainToZero(breach, observation({ marketCap: 0n }))).toBe(true);
  });

  it('is false for a priority withdrawal back to a non-zero cap', () => {
    const breach = decision({ targetAmount: parseEther('4000000'), bandUtilBps: undefined, priority: true, rule: 'R-PRIORITY-WITHDRAWAL' });
    expect(isDrainToZero(breach, observation({ marketCap: parseEther('4000000') }))).toBe(false);
  });

  it('is false for a RETIRED hold even when the market has a zero cap', () => {
    const hold = decision({ targetAmount: parseEther('4100000'), bandUtilBps: undefined, rule: 'R-RETIRED' });
    expect(isDrainToZero(hold, observation({ mode: 'RETIRED', marketCap: 0n }))).toBe(false);
  });

  it('is false for a band drain', () => {
    expect(isDrainToZero(decision(), observation())).toBe(false);
  });
});
