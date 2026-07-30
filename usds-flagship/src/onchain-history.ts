/**
 * On-chain action history for the band-steering controller.
 *
 * The band controller's direction-change cooldown (24h) and the SOUNDING feed
 * cooldown both need to know when the bot last allocated to / deallocated from
 * each market. Rather than persisting local state between cron runs (fragile on
 * Railway), we reconstruct it from Morpho Blue's own event log: every vault
 * allocation surfaces as a `Supply` event and every deallocation as a `Withdraw`
 * event with `onBehalf` = our adapter.
 *
 * Events (Morpho Blue, 0xBBBB…FFCb):
 *   Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf,
 *          uint256 assets, uint256 shares)
 *   Withdraw(bytes32 indexed id, address caller, address indexed onBehalf,
 *            address indexed receiver, uint256 assets, uint256 shares)
 *
 * KNOWN ACCEPTED LIMITATION: we filter only on `onBehalf` = adapter, so ANY
 * event on behalf of the adapter counts as a bot action — including a
 * third-party `forceDeallocate` (which emits Withdraw with onBehalf = adapter).
 * That pollution is conservative: at worst the controller sees a recent
 * "deallocate" it didn't make and holds for up to 24h (cooldown), which is a
 * safe no-op, never a wrong-direction trade.
 *
 * Failure policy: fail loud. Any RPC error (getLogs / getBlock) propagates to
 * the caller, which must abort the whole cycle — steering on incomplete
 * history could bypass a cooldown that is actually active.
 *
 * All timestamps are UTC epoch seconds (block timestamps are UTC by definition).
 */
import { parseAbiItem, type AbiEvent, type Address, type Hex } from 'viem';

/**
 * Latest bot action timestamps for one market within the queried block window.
 * `undefined` means no event of that type in the window (the caller treats
 * that as "cooldown expired").
 */
export interface MarketActionHistory {
  lastAllocateAtSec?: number;
  lastDeallocateAtSec?: number;
}

const SUPPLY_EVENT = parseAbiItem(
  'event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)',
);
const WITHDRAW_EVENT = parseAbiItem(
  'event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
);

/**
 * The one shape of log this module consumes. `blockNumber`/`logIndex` are
 * nullable to match viem's Log type (null only for pending logs, which a
 * historical fromBlock/toBlock query never returns — we throw if one appears).
 */
export interface ActionHistoryLog {
  args: { id?: Hex };
  blockNumber: bigint | null;
  logIndex: number | null;
}

/**
 * Structural subset of a viem PublicClient — just the two methods this module
 * calls, typed minimally so unit tests can pass plain `{ getLogs, getBlock }`
 * stubs without a network. Any viem PublicClient satisfies it (cast at the
 * call site if the generic signatures don't unify structurally).
 */
export interface ActionHistoryClient {
  getLogs(params: {
    address: Address;
    event: AbiEvent;
    args: { onBehalf: Address };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ActionHistoryLog[]>;
  getBlock(params: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

/**
 * Reduce a list of event logs to the single LATEST log per market id, ordered
 * by (blockNumber, logIndex). Logs for market ids outside `wantedIds` are
 * ignored (the getLogs filter is onBehalf-only; id filtering is client-side).
 * Ids compare lowercase. Throws on a log with a missing decoded id or a
 * null blockNumber/logIndex (pending log) — both indicate a broken RPC
 * response, not a condition to steer through.
 */
function pickLatestPerMarket(
  logs: ActionHistoryLog[],
  wantedIds: Set<string>,
  eventName: string,
): Map<string, { blockNumber: bigint; logIndex: number }> {
  const latest = new Map<string, { blockNumber: bigint; logIndex: number }>();
  for (const log of logs) {
    const id = log.args.id?.toLowerCase();
    if (id === undefined) {
      throw new Error(`${eventName} log missing decoded market id (malformed RPC response)`);
    }
    if (!wantedIds.has(id)) continue;
    if (log.blockNumber === null || log.logIndex === null) {
      throw new Error(`${eventName} log for market ${id} has null blockNumber/logIndex (pending log in a historical query)`);
    }
    const prev = latest.get(id);
    if (
      prev === undefined ||
      log.blockNumber > prev.blockNumber ||
      (log.blockNumber === prev.blockNumber && log.logIndex > prev.logIndex)
    ) {
      latest.set(id, { blockNumber: log.blockNumber, logIndex: log.logIndex });
    }
  }
  return latest;
}

/**
 * Fetch the bot's last allocate/deallocate timestamps per market from Morpho
 * Blue events in [fromBlock, toBlock].
 *
 * Two getLogs calls (Supply, Withdraw), each filtered on-node by
 * `onBehalf` = adapter (an indexed topic), then filtered client-side to the
 * requested `marketIds` (ids compare lowercase). For each (market, event type)
 * only the latest log — by (blockNumber, logIndex) — is kept; its block
 * timestamp becomes lastAllocateAtSec (Supply) / lastDeallocateAtSec
 * (Withdraw). Unique block numbers are resolved to timestamps in one parallel
 * getBlock batch, so N markets in the same block cost one block fetch.
 *
 * Returns a Map with one entry per REQUESTED market id (key: lowercase id),
 * so callers never need a missing-key branch — a market with no events in the
 * window maps to `{}` (both fields undefined). The caller picks fromBlock so
 * the window covers at least the longest cooldown lookback (24h).
 *
 * THROWS on any RPC failure or malformed log — the caller must abort the
 * cycle rather than steer on incomplete history.
 */
export async function fetchActionHistory(
  client: ActionHistoryClient,
  args: {
    morphoBlue: `0x${string}`;
    adapter: `0x${string}`;
    marketIds: `0x${string}`[];
    fromBlock: bigint;
    toBlock: bigint;
  },
): Promise<Map<string, MarketActionHistory>> {
  const { morphoBlue, adapter, marketIds, fromBlock, toBlock } = args;
  const wantedIds = new Set(marketIds.map(id => id.toLowerCase()));

  const [supplyLogs, withdrawLogs] = await Promise.all([
    client.getLogs({ address: morphoBlue, event: SUPPLY_EVENT, args: { onBehalf: adapter }, fromBlock, toBlock }),
    client.getLogs({ address: morphoBlue, event: WITHDRAW_EVENT, args: { onBehalf: adapter }, fromBlock, toBlock }),
  ]);

  const latestSupply = pickLatestPerMarket(supplyLogs, wantedIds, 'Supply');
  const latestWithdraw = pickLatestPerMarket(withdrawLogs, wantedIds, 'Withdraw');

  // Resolve each unique block number to its timestamp exactly once, in parallel.
  // (bigints are primitives, so Set dedupes equal block numbers correctly.)
  const uniqueBlocks = new Set<bigint>();
  for (const { blockNumber } of latestSupply.values()) uniqueBlocks.add(blockNumber);
  for (const { blockNumber } of latestWithdraw.values()) uniqueBlocks.add(blockNumber);

  const timestampByBlock = new Map<bigint, number>();
  await Promise.all(
    [...uniqueBlocks].map(async blockNumber => {
      const block = await client.getBlock({ blockNumber });
      timestampByBlock.set(blockNumber, Number(block.timestamp));
    }),
  );

  const history = new Map<string, MarketActionHistory>();
  for (const id of wantedIds) history.set(id, {});
  for (const [id, { blockNumber }] of latestSupply) {
    history.get(id)!.lastAllocateAtSec = timestampByBlock.get(blockNumber)!;
  }
  for (const [id, { blockNumber }] of latestWithdraw) {
    history.get(id)!.lastDeallocateAtSec = timestampByBlock.get(blockNumber)!;
  }
  return history;
}
