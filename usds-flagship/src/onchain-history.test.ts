import { describe, it, expect, vi } from 'vitest';
import { fetchActionHistory, type ActionHistoryClient, type ActionHistoryLog } from './onchain-history.js';

// ---------------------------------------------------------------------------
// Fixtures. Market ids are arbitrary bytes32; the adapter/morpho addresses are
// only echoed into the stub's recorded calls (no network anywhere in this file).
// ---------------------------------------------------------------------------

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as `0x${string}`;
const ADAPTER = '0x00000000000000000000000000000000000000Ad' as `0x${string}`;
const MARKET_A = `0x${'11'.repeat(32)}` as `0x${string}`;
const MARKET_B = `0x${'22'.repeat(32)}` as `0x${string}`;
const FOREIGN_MARKET = `0x${'ff'.repeat(32)}` as `0x${string}`;

const FROM_BLOCK = 1_000n;
const TO_BLOCK = 2_000n;

/** Build a decoded event log the way viem's getLogs returns them. */
function log(id: `0x${string}`, blockNumber: bigint, logIndex = 0): ActionHistoryLog {
  return { args: { id }, blockNumber, logIndex };
}

/**
 * Minimal { getLogs, getBlock } stub. getLogs dispatches on the event name it
 * receives (Supply vs Withdraw); getBlock maps blockNumber -> timestamp via
 * `blockTimestamps` (throws on an unknown block so a bad lookup fails loud in
 * the test too). Both are vi.fn so tests can assert call shapes/counts.
 */
function mockClient(opts: {
  supplyLogs?: ActionHistoryLog[];
  withdrawLogs?: ActionHistoryLog[];
  blockTimestamps?: Record<string, bigint>; // key: blockNumber.toString()
}) {
  const getLogs = vi.fn(async (params: { event: { name?: string }; [k: string]: unknown }) => {
    if (params.event.name === 'Supply') return opts.supplyLogs ?? [];
    if (params.event.name === 'Withdraw') return opts.withdrawLogs ?? [];
    throw new Error(`unexpected event ${params.event.name}`);
  });
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    const timestamp = opts.blockTimestamps?.[blockNumber.toString()];
    if (timestamp === undefined) throw new Error(`no stubbed timestamp for block ${blockNumber}`);
    return { timestamp };
  });
  const client = { getLogs, getBlock } as unknown as ActionHistoryClient;
  return { client, getLogs, getBlock };
}

function callArgs() {
  return { morphoBlue: MORPHO, adapter: ADAPTER, marketIds: [MARKET_A, MARKET_B], fromBlock: FROM_BLOCK, toBlock: TO_BLOCK };
}

describe('fetchActionHistory', () => {
  it('empty window: returns an entry per requested market with both fields undefined, no block fetches', async () => {
    const { client, getBlock } = mockClient({});

    const history = await fetchActionHistory(client, callArgs());

    expect(history.size).toBe(2);
    expect(history.get(MARKET_A)).toEqual({});
    expect(history.get(MARKET_B)).toEqual({});
    expect(history.get(MARKET_A)!.lastAllocateAtSec).toBeUndefined();
    expect(history.get(MARKET_A)!.lastDeallocateAtSec).toBeUndefined();
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('queries both events filtered by onBehalf=adapter over [fromBlock, toBlock] at the Morpho address', async () => {
    const { client, getLogs } = mockClient({});

    await fetchActionHistory(client, callArgs());

    expect(getLogs).toHaveBeenCalledTimes(2);
    const eventNames = getLogs.mock.calls.map(([params]) => (params.event as { name?: string }).name).sort();
    expect(eventNames).toEqual(['Supply', 'Withdraw']);
    for (const [params] of getLogs.mock.calls) {
      expect(params).toMatchObject({
        address: MORPHO,
        args: { onBehalf: ADAPTER },
        fromBlock: FROM_BLOCK,
        toBlock: TO_BLOCK,
      });
    }
  });

  it('Supply populates lastAllocateAtSec and Withdraw populates lastDeallocateAtSec', async () => {
    const { client } = mockClient({
      supplyLogs: [log(MARKET_A, 1_100n)],
      withdrawLogs: [log(MARKET_B, 1_200n)],
      blockTimestamps: { '1100': 1_753_000_000n, '1200': 1_753_100_000n },
    });

    const history = await fetchActionHistory(client, callArgs());

    expect(history.get(MARKET_A)).toEqual({ lastAllocateAtSec: 1_753_000_000 });
    expect(history.get(MARKET_B)).toEqual({ lastDeallocateAtSec: 1_753_100_000 });
  });

  it('both event types on the same market populate both fields independently', async () => {
    const { client } = mockClient({
      supplyLogs: [log(MARKET_A, 1_100n)],
      withdrawLogs: [log(MARKET_A, 1_500n)],
      blockTimestamps: { '1100': 1_753_000_000n, '1500': 1_753_400_000n },
    });

    const history = await fetchActionHistory(client, callArgs());

    expect(history.get(MARKET_A)).toEqual({
      lastAllocateAtSec: 1_753_000_000,
      lastDeallocateAtSec: 1_753_400_000,
    });
  });

  it('multiple events for one market: the latest by block number wins', async () => {
    const { client, getBlock } = mockClient({
      supplyLogs: [
        log(MARKET_A, 1_100n),
        log(MARKET_A, 1_900n), // latest — deliberately not last in the array
        log(MARKET_A, 1_400n),
      ],
      blockTimestamps: { '1900': 1_753_900_000n },
    });

    const history = await fetchActionHistory(client, callArgs());

    expect(history.get(MARKET_A)).toEqual({ lastAllocateAtSec: 1_753_900_000 });
    // Only the winning log's block is resolved — losers cost nothing.
    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: 1_900n });
  });

  it('same-block events tie-break on logIndex without double-fetching the block', async () => {
    const { client, getBlock } = mockClient({
      supplyLogs: [log(MARKET_A, 1_300n, 7), log(MARKET_A, 1_300n, 2)],
      withdrawLogs: [log(MARKET_B, 1_300n, 5)],
      blockTimestamps: { '1300': 1_753_300_000n },
    });

    const history = await fetchActionHistory(client, callArgs());

    expect(history.get(MARKET_A)).toEqual({ lastAllocateAtSec: 1_753_300_000 });
    expect(history.get(MARKET_B)).toEqual({ lastDeallocateAtSec: 1_753_300_000 });
    // One unique block across three logs -> exactly one getBlock call.
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it('ignores events for market ids outside the requested set', async () => {
    const { client, getBlock } = mockClient({
      supplyLogs: [log(FOREIGN_MARKET, 1_800n)],
      withdrawLogs: [log(FOREIGN_MARKET, 1_850n)],
    });

    const history = await fetchActionHistory(client, callArgs());

    expect(history.size).toBe(2);
    expect(history.get(MARKET_A)).toEqual({});
    expect(history.get(MARKET_B)).toEqual({});
    expect(history.has(FOREIGN_MARKET)).toBe(false);
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('matches ids case-insensitively and keys the result lowercase', async () => {
    const upperCaseId = `0x${'AB'.repeat(32)}` as `0x${string}`;
    const lowerCaseId = upperCaseId.toLowerCase();
    const { client } = mockClient({
      // RPC returns the id lowercase; the caller asked with uppercase hex.
      supplyLogs: [{ args: { id: lowerCaseId as `0x${string}` }, blockNumber: 1_100n, logIndex: 0 }],
      blockTimestamps: { '1100': 1_753_000_000n },
    });

    const history = await fetchActionHistory(client, {
      ...callArgs(),
      marketIds: [upperCaseId],
    });

    expect(history.size).toBe(1);
    expect([...history.keys()]).toEqual([lowerCaseId]);
    expect(history.get(lowerCaseId)).toEqual({ lastAllocateAtSec: 1_753_000_000 });
  });

  it('propagates a getLogs RPC failure (no swallowing)', async () => {
    const { client, getLogs } = mockClient({});
    getLogs.mockRejectedValue(new Error('rpc: getLogs range too large'));

    await expect(fetchActionHistory(client, callArgs())).rejects.toThrow('rpc: getLogs range too large');
  });

  it('propagates a getBlock RPC failure (no swallowing)', async () => {
    const { client, getBlock } = mockClient({
      supplyLogs: [log(MARKET_A, 1_100n)],
      blockTimestamps: { '1100': 1_753_000_000n },
    });
    getBlock.mockRejectedValue(new Error('rpc: block fetch failed'));

    await expect(fetchActionHistory(client, callArgs())).rejects.toThrow('rpc: block fetch failed');
  });

  it('throws on a pending log (null blockNumber) instead of steering on bad data', async () => {
    const { client } = mockClient({
      supplyLogs: [{ args: { id: MARKET_A }, blockNumber: null, logIndex: null }],
    });

    await expect(fetchActionHistory(client, callArgs())).rejects.toThrow(/null blockNumber/);
  });

  it('throws on a log with a missing decoded id (malformed RPC response)', async () => {
    const { client } = mockClient({
      withdrawLogs: [{ args: {}, blockNumber: 1_100n, logIndex: 0 }],
    });

    await expect(fetchActionHistory(client, callArgs())).rejects.toThrow(/missing decoded market id/);
  });
});
