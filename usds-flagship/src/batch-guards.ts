/**
 * Pre-flight safety checks on a fully planned bands-mode batch (spec: the allocator
 * may do nothing, it must never do something bad).
 *
 * The reconciled legs are the ONLY authority on what this cycle may move. Between
 * reconciliation and the Safe batch the amounts pass through several mutating stages
 * (per-cycle clamps, liquidity caps, dust filters, budget scaling) that are all only
 * allowed to SHRINK legs — this module re-verifies that on the final call list and
 * throws on any violation, so a wiring bug or an anomalous fresh read aborts the
 * cycle with no transaction instead of trading on it. PURE: no RPC, no env.
 */

export interface PlannedBatchCall {
  marketIndex: number;
  action: 'allocate' | 'deallocate';
  amount: bigint;
}

/**
 * Throws unless every call conforms to its reconciled leg and the batch as a whole
 * keeps the sleeve safe. Checks, in order:
 *
 *   1. shape — known market index, positive amount, at most one call per market;
 *   2. leg conformance — same direction as the leg, amount not above the leg,
 *      a deallocate not above the pinned position;
 *   3. step caps — no call above MAX_ALLOCATE_USDS / MAX_DEALLOCATE_USDS;
 *   4. sleeve band — the post-batch sleeve (on the pinned snapshot) must not cross
 *      out of [floor, cap], and when it already starts outside, the batch must move
 *      it toward the band, never further away.
 *
 * An empty call list passes trivially — doing nothing is always safe.
 */
export function assertBandBatchSafe(args: {
  calls: PlannedBatchCall[];
  /** Reconciled per-market deltas (target - pinned position), the plan's authority. */
  legDeltas: bigint[];
  pinnedPerMarketAssets: bigint[];
  pinnedTotalAssets: bigint;
  sleeveFloorBps: number;
  sleeveCapBps: number;
  maxAllocateUsds: bigint;
  maxDeallocateUsds: bigint;
  marketNames: string[];
}): void {
  const {
    calls, legDeltas, pinnedPerMarketAssets, pinnedTotalAssets,
    sleeveFloorBps, sleeveCapBps, maxAllocateUsds, maxDeallocateUsds, marketNames,
  } = args;

  const seen = new Set<number>();
  for (const call of calls) {
    if (call.marketIndex < 0 || call.marketIndex >= legDeltas.length) {
      throw new Error(`batch guard: call for unknown market index ${call.marketIndex}`);
    }
    const name = marketNames[call.marketIndex];
    if (seen.has(call.marketIndex)) {
      throw new Error(`batch guard: ${name} appears more than once in the batch`);
    }
    seen.add(call.marketIndex);
    if (call.amount <= 0n) {
      throw new Error(`batch guard: ${name} ${call.action} amount ${call.amount} is not positive`);
    }

    const leg = legDeltas[call.marketIndex];
    if (call.action === 'allocate') {
      if (leg <= 0n) {
        throw new Error(`batch guard: ${name} allocate has no matching deposit leg (leg delta ${leg})`);
      }
      if (call.amount > leg) {
        throw new Error(`batch guard: ${name} allocate ${call.amount} exceeds its leg ${leg}`);
      }
      if (call.amount > maxAllocateUsds) {
        throw new Error(`batch guard: ${name} allocate ${call.amount} exceeds MAX_ALLOCATE_USDS ${maxAllocateUsds}`);
      }
    } else {
      if (leg >= 0n) {
        throw new Error(`batch guard: ${name} deallocate has no matching withdrawal leg (leg delta ${leg})`);
      }
      if (call.amount > -leg) {
        throw new Error(`batch guard: ${name} deallocate ${call.amount} exceeds its leg ${-leg}`);
      }
      if (call.amount > pinnedPerMarketAssets[call.marketIndex]) {
        throw new Error(
          `batch guard: ${name} deallocate ${call.amount} exceeds the pinned position ` +
          `${pinnedPerMarketAssets[call.marketIndex]}`
        );
      }
      if (call.amount > maxDeallocateUsds) {
        throw new Error(`batch guard: ${name} deallocate ${call.amount} exceeds MAX_DEALLOCATE_USDS ${maxDeallocateUsds}`);
      }
    }
  }

  const sleeveBefore = pinnedPerMarketAssets.reduce((sum, x) => sum + x, 0n);
  const sleeveAfter = calls.reduce(
    (sleeve, c) => c.action === 'allocate' ? sleeve + c.amount : sleeve - c.amount,
    sleeveBefore,
  );
  const cap = (pinnedTotalAssets * BigInt(sleeveCapBps)) / 10000n;
  const floor = (pinnedTotalAssets * BigInt(sleeveFloorBps)) / 10000n;

  // A sleeve already outside the band (drift) may stay outside as long as the batch
  // moves it toward the band; a sleeve inside must stay inside. This is where a
  // dropped deposit whose offsetting withdrawal survived gets caught.
  const upperBound = sleeveBefore > cap ? sleeveBefore : cap;
  const lowerBound = sleeveBefore < floor ? sleeveBefore : floor;
  if (sleeveAfter > upperBound) {
    throw new Error(
      `batch guard: post-batch sleeve ${sleeveAfter} would exceed the ${sleeveCapBps} bps cap ` +
      `(${cap} of totalAssets ${pinnedTotalAssets}, sleeve before ${sleeveBefore})`
    );
  }
  if (sleeveAfter < lowerBound) {
    throw new Error(
      `batch guard: post-batch sleeve ${sleeveAfter} would break the ${sleeveFloorBps} bps floor ` +
      `(${floor} of totalAssets ${pinnedTotalAssets}, sleeve before ${sleeveBefore})`
    );
  }
}
