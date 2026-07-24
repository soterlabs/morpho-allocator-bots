/**
 * Pure migration logic for the USDT Savings Vault Allocator Bot.
 *
 * Extracted from allocator.ts so the fund-affecting decisions can be unit-tested without RPC
 * or Safe dependencies. All amounts are in the vault's asset units (USDT, 6 decimals) — the
 * math is decimal-agnostic, working in raw integer units throughout.
 */

/**
 * Maximum amount withdrawable from a Morpho Blue market without pushing utilization above
 * maxUtilizationBps. Deallocating removes supply while borrows stay put, so withdrawing W
 * leaves utilization = borrow / (supply - W). We keep that <= maxUtil, i.e.
 *   supply - W >= borrow / maxUtil  =>  W <= supply - ceil(borrow / maxUtil).
 *
 * ceil is used on the required remaining supply so post-withdraw utilization never rounds
 * *above* the target. Returns 0 when the market is already at/above the target utilization
 * (the caller should then wait for borrowers to repay). With zero borrows the whole supply is
 * withdrawable. This is stricter than "all idle liquidity" (which would allow util → 100%).
 */
export function maxWithdrawableForUtilization(
  totalSupplyAssets: bigint,
  totalBorrowAssets: bigint,
  maxUtilizationBps: number,
): bigint {
  if (totalBorrowAssets <= 0n) return totalSupplyAssets;
  if (maxUtilizationBps <= 0) return 0n;
  const util = BigInt(maxUtilizationBps);
  // ceil(borrow * 10000 / maxUtilBps)
  const minSupplyAfter = (totalBorrowAssets * 10000n + util - 1n) / util;
  return totalSupplyAssets > minSupplyAfter ? totalSupplyAssets - minSupplyAfter : 0n;
}

export interface MigrationInput {
  // The vault's current position in the OLD market (asset units), i.e. how much is left to move.
  oldPosition: bigint;
  // OLD market pool state, for the utilization cap.
  oldTotalSupplyAssets: bigint;
  oldTotalBorrowAssets: bigint;
  // Max utilization (bps) we allow the OLD market to reach while withdrawing (e.g. 9300 = 93%).
  maxUtilizationBps: number;
  // Dust floor (asset units) below which we don't bother executing a round.
  minAmount: bigint;
}

export type MigrationPlan =
  | { status: 'migrate'; amount: bigint; utilizationCapped: boolean; withdrawableByUtilization: bigint }
  | { status: 'wait-utilization'; withdrawableByUtilization: bigint }
  | { status: 'done'; oldPosition: bigint }
  | { status: 'dust'; amount: bigint };

/**
 * Decide how much to move from the old market to the new market this round.
 *
 * The amount is min(oldPosition, utilization-capped withdrawable). Outcomes:
 *   - 'done'             — the old market is empty (position below dust): migration complete.
 *   - 'wait-utilization' — old market already at/above the max utilization: withdraw nothing,
 *                          wait for borrowers to repay (rising rates incentivize this).
 *   - 'dust'             — some liquidity is technically withdrawable but below the dust floor;
 *                          skip this round to avoid a tiny transaction.
 *   - 'migrate'          — deallocate `amount` from old and allocate the same to new (atomic).
 */
export function computeMigration(input: MigrationInput): MigrationPlan {
  const { oldPosition, oldTotalSupplyAssets, oldTotalBorrowAssets, maxUtilizationBps, minAmount } = input;

  // Nothing left in the old market — migration is complete.
  if (oldPosition < minAmount) {
    return { status: 'done', oldPosition };
  }

  const withdrawableByUtilization = maxWithdrawableForUtilization(
    oldTotalSupplyAssets,
    oldTotalBorrowAssets,
    maxUtilizationBps,
  );

  // Old market is at/above the utilization ceiling — do not push it further; wait.
  if (withdrawableByUtilization === 0n) {
    return { status: 'wait-utilization', withdrawableByUtilization };
  }

  const amount = oldPosition < withdrawableByUtilization ? oldPosition : withdrawableByUtilization;

  // Withdrawable this round is below the dust floor — skip rather than send a tiny tx.
  if (amount < minAmount) {
    return { status: 'dust', amount };
  }

  return {
    status: 'migrate',
    amount,
    utilizationCapped: withdrawableByUtilization < oldPosition,
    withdrawableByUtilization,
  };
}
