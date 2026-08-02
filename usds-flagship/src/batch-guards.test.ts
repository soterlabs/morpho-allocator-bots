import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { assertBandBatchSafe, type PlannedBatchCall } from './batch-guards.js';

// Production-scale vault: 35M totalAssets -> sleeve cap 20% = 7M, floor 15% = 5.25M.
// Three markets holding 4.1M / 1.2M / 0.7M -> sleeve 6.0M; step caps 1M.
function guard(overrides: {
  calls: PlannedBatchCall[];
  legDeltas: bigint[];
  pinnedPerMarketAssets?: bigint[];
}) {
  return () => assertBandBatchSafe({
    pinnedPerMarketAssets: [parseEther('4100000'), parseEther('1200000'), parseEther('700000')],
    pinnedTotalAssets: parseEther('35000000'),
    sleeveFloorBps: 1500,
    sleeveCapBps: 2000,
    maxAllocateUsds: parseEther('1000000'),
    maxDeallocateUsds: parseEther('1000000'),
    marketNames: ['cbBTC/USDS', 'wstETH/USDS', 'PT-sUSDS/USDS'],
    ...overrides,
  });
}

describe('leg conformance', () => {
  it('accepts a batch that executes its legs exactly', () => {
    expect(guard({
      calls: [
        { marketIndex: 0, action: 'deallocate', amount: parseEther('200000') },
        { marketIndex: 1, action: 'allocate', amount: parseEther('150000') },
      ],
      legDeltas: [-parseEther('200000'), parseEther('150000'), 0n],
    })).not.toThrow();
  });

  it('accepts a batch whose amounts were shrunk by downstream clamps', () => {
    expect(guard({
      calls: [
        { marketIndex: 0, action: 'deallocate', amount: parseEther('120000') },
        { marketIndex: 1, action: 'allocate', amount: parseEther('100000') },
      ],
      legDeltas: [-parseEther('200000'), parseEther('150000'), 0n],
    })).not.toThrow();
  });

  it('accepts an empty batch — doing nothing is always safe', () => {
    expect(guard({ calls: [], legDeltas: [0n, 0n, 0n] })).not.toThrow();
  });

  it('throws on an action for a market whose leg is zero (phantom action)', () => {
    expect(guard({
      calls: [{ marketIndex: 2, action: 'deallocate', amount: parseEther('150000') }],
      legDeltas: [0n, 0n, 0n],
    })).toThrow(/no matching withdrawal leg/);
  });

  it('throws on an action against the direction of its leg', () => {
    expect(guard({
      calls: [{ marketIndex: 0, action: 'allocate', amount: parseEther('200000') }],
      legDeltas: [-parseEther('200000'), 0n, 0n],
    })).toThrow(/no matching deposit leg/);
  });

  it('throws on an amount above its leg', () => {
    expect(guard({
      calls: [{ marketIndex: 0, action: 'deallocate', amount: parseEther('250000') }],
      legDeltas: [-parseEther('200000'), 0n, 0n],
    })).toThrow(/exceeds its leg/);
  });

  it('throws on a deallocate above the pinned position', () => {
    expect(guard({
      calls: [{ marketIndex: 2, action: 'deallocate', amount: parseEther('750000') }],
      legDeltas: [0n, 0n, -parseEther('800000')],
    })).toThrow(/exceeds the pinned position/);
  });
});

describe('step caps and batch shape', () => {
  it('throws on an allocate above MAX_ALLOCATE_USDS', () => {
    expect(guard({
      calls: [{ marketIndex: 1, action: 'allocate', amount: parseEther('1200000') }],
      legDeltas: [0n, parseEther('1500000'), 0n],
    })).toThrow(/MAX_ALLOCATE_USDS/);
  });

  it('throws on a deallocate above MAX_DEALLOCATE_USDS', () => {
    expect(guard({
      calls: [{ marketIndex: 0, action: 'deallocate', amount: parseEther('1200000') }],
      legDeltas: [-parseEther('1500000'), 0n, 0n],
    })).toThrow(/MAX_DEALLOCATE_USDS/);
  });

  it('throws when the same market appears twice in the batch', () => {
    expect(guard({
      calls: [
        { marketIndex: 0, action: 'deallocate', amount: parseEther('100000') },
        { marketIndex: 0, action: 'deallocate', amount: parseEther('100000') },
      ],
      legDeltas: [-parseEther('200000'), 0n, 0n],
    })).toThrow(/more than once/);
  });

  it('throws on a non-positive amount', () => {
    expect(guard({
      calls: [{ marketIndex: 0, action: 'deallocate', amount: 0n }],
      legDeltas: [-parseEther('200000'), 0n, 0n],
    })).toThrow(/not positive/);
  });

  it('throws on an unknown market index', () => {
    expect(guard({
      calls: [{ marketIndex: 7, action: 'allocate', amount: parseEther('150000') }],
      legDeltas: [0n, 0n, 0n],
    })).toThrow(/unknown market/);
  });
});

describe('post-batch sleeve band', () => {
  it('throws when a surviving withdrawal without its offsetting deposit would break the floor', () => {
    // Reconcile balanced -800k against +150k; the deposit died downstream. Executing
    // the withdrawal alone lands the sleeve at 5.2M, under the 5.25M floor.
    expect(guard({
      calls: [{ marketIndex: 0, action: 'deallocate', amount: parseEther('800000') }],
      legDeltas: [-parseEther('800000'), parseEther('150000'), 0n],
    })).toThrow(/floor/);
  });

  it('throws when the batch would end above the cap', () => {
    // 6.0M sleeve + 600k + 500k = 7.1M > 7M.
    expect(guard({
      calls: [
        { marketIndex: 0, action: 'allocate', amount: parseEther('600000') },
        { marketIndex: 1, action: 'allocate', amount: parseEther('500000') },
      ],
      legDeltas: [parseEther('600000'), parseEther('500000'), 0n],
    })).toThrow(/cap/);
  });

  it('allows a batch that moves an over-cap sleeve toward the band', () => {
    // Drifted sleeve 7.3M > 7M cap; a 200k drain improves it to 7.1M.
    expect(guard({
      calls: [{ marketIndex: 0, action: 'deallocate', amount: parseEther('200000') }],
      legDeltas: [-parseEther('200000'), 0n, 0n],
      pinnedPerMarketAssets: [parseEther('6500000'), parseEther('800000'), 0n],
    })).not.toThrow();
  });

  it('throws when the batch pushes an over-cap sleeve further up', () => {
    expect(guard({
      calls: [{ marketIndex: 1, action: 'allocate', amount: parseEther('150000') }],
      legDeltas: [0n, parseEther('150000'), 0n],
      pinnedPerMarketAssets: [parseEther('6500000'), parseEther('800000'), 0n],
    })).toThrow(/cap/);
  });

  it('allows a batch that lifts an under-floor sleeve toward the band', () => {
    // Drifted sleeve 5.0M < 5.25M floor; a 200k deposit improves it to 5.2M.
    expect(guard({
      calls: [{ marketIndex: 1, action: 'allocate', amount: parseEther('200000') }],
      legDeltas: [0n, parseEther('200000'), 0n],
      pinnedPerMarketAssets: [parseEther('4000000'), parseEther('1000000'), 0n],
    })).not.toThrow();
  });
});
