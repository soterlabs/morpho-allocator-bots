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

export interface LiquidityRouteInput {
  // The vault's current `liquidityAdapter()` (zero address = no default route configured).
  currentAdapter: string;
  // The vault's current `liquidityData()` — for a Morpho market adapter this is
  // abi.encode(MarketParams), i.e. it selects which market the route points at.
  currentData: string;
  // What the route should be: this bot's adapter, pointed at the NEW market.
  desiredAdapter: string;
  desiredData: string;
  // The OLD market's encoded params — the only route the bot is willing to take over (see below).
  migrateFromData: string;
  // Ops kill switch (MANAGE_LIQUIDITY_ADAPTER): when false the bot never rewrites the route.
  enabled: boolean;
}

export type LiquidityRoutePlan =
  | { status: 'ok' }
  | { status: 'update' }
  | { status: 'foreign-adapter'; currentAdapter: string }
  | { status: 'foreign-market'; currentData: string }
  | { status: 'disabled' };

/**
 * Decide whether the vault's default liquidity route (`liquidityAdapter` + `liquidityData`)
 * needs to be repointed at the NEW market.
 *
 * The route is what a plain `deposit` into the vault follows: the vault forwards the deposited
 * assets straight to `liquidityAdapter` with `liquidityData`, so while it still encodes the OLD
 * market every new deposit lands back in the market we are draining. Rewriting it is idempotent,
 * which is why the bot can (and does) re-check it every run.
 *
 * The bot's mandate is narrow — "get the default route off the OLD market", not "own the route
 * forever". So it only takes over a route that is unset or still points at the OLD market; a route
 * aimed anywhere else is someone else's decision and is left alone. Without that guard a curator
 * pointing the route at a third market would be silently overwritten on every run, forever.
 *
 * Outcomes:
 *   - 'ok'              — already this bot's adapter pointed at the new market: nothing to do.
 *   - 'update'          — call setLiquidityAdapterAndData(desiredAdapter, desiredData).
 *   - 'foreign-adapter' — the route points at some *other* adapter contract; that is a curator
 *                         decision the bot must not silently overwrite, so it leaves it alone.
 *   - 'foreign-market'  — our adapter, but aimed at a market that is neither old nor new; same
 *                         reasoning: leave it alone and report it.
 *   - 'disabled'        — a change is needed but the kill switch is off.
 *
 * Address/bytes comparisons are case-insensitive (RPCs return mixed checksum casing).
 */
export function planLiquidityRoute(input: LiquidityRouteInput): LiquidityRoutePlan {
  const { currentAdapter, currentData, desiredAdapter, desiredData, migrateFromData, enabled } = input;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (eq(currentAdapter, desiredAdapter) && eq(currentData, desiredData)) return { status: 'ok' };
  if (!enabled) return { status: 'disabled' };

  // Zero address / empty data = no route at all (deposits sit idle); adopting ours is the
  // intended fix rather than an overwrite of anyone's decision.
  const adapterUnset = /^0x0{40}$/.test(currentAdapter);
  if (!adapterUnset && !eq(currentAdapter, desiredAdapter)) return { status: 'foreign-adapter', currentAdapter };

  const dataUnset = !currentData || currentData === '0x';
  if (!dataUnset && !eq(currentData, migrateFromData)) return { status: 'foreign-market', currentData };

  return { status: 'update' };
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
