/**
 * Flagship Vault V2 Allocator Bot
 *
 * This bot steers the 80% idle / 20% allocated strategy for the Flagship USDS Vault
 * across 5 markets: stUSDS, cbBTC, wstETH, PT-sUSDS, WETH (all with USDS as loan token).
 *
 * Two allocation modes, selected by the REQUIRED env var ALLOCATION_MODE:
 *
 *   'bps'   — legacy static targets. Each market has a target in basis points
 *             (TARGET_<MARKET>_BPS; sum must equal targetAllocatedPercent). PT-sUSDS has a
 *             5M USDS absolute cap enforced off-chain; overflow above the cap is split
 *             equally between cbBTC and wstETH. WETH is drained only up to 93% market
 *             utilization (waits above it).
 *
 *   'bands' — Phase A utilization-band rate steering. Per-market targets come from
 *             computeBandDecisions (band-controller.ts): STEERED markets are held to a
 *             utilization band chosen from the market's supply APY vs on-chain SSR
 *             thresholds, SOUNDING markets are fed tranches while demand sticks, RETIRED
 *             (and post-maturity PT) markets drain to zero. The decision inputs and the
 *             resulting rules are logged as one BAND_TRACE JSON line per run, including a
 *             log-only 24h anchor-rate projection at post-trade utilization (A/B bracket,
 *             no veto in v1).
 *
 * Transactions are executed through a Safe 1/3 multisig. The bot is one of the 3 signers
 * and can execute autonomously since the threshold is 1.
 *
 * Run as a Railway cron service every 20 minutes (cronSchedule in railway.toml).
 *
 * Environment Variables (see .env.example):
 *   - ALLOCATION_MODE: REQUIRED, 'bps' | 'bands'
 *   - RPC_URL: Ethereum RPC endpoint (REQUIRED, no default)
 *   - PRIVATE_KEY: Bot signer's private key (one of the Safe owners)
 *   - SAFE_ADDRESS: Safe 1/3 multisig address (set as allocator on the vault)
 *   - VAULT_ADDRESS: Flagship Vault V2 address
 *   - ADAPTER_ADDRESS: MorphoMarketV1AdapterV2 address
 *   - BOT_PAUSED: 'true' -> log and exit 0 without touching anything
 */

import { createPublicClient, createWalletClient, http, formatEther, parseEther, encodeFunctionData, hexToBytes, bytesToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { createHash } from 'node:crypto';
import { Market, MarketParams } from '@morpho-org/blue-sdk';
import 'dotenv/config';
import { computeAllocationActions, computeCapLimit, CAP_HEADROOM_BPS, capDeallocationsToLiquidity, validateTargetBpsSum, computeEffectiveTargetAmounts, planDeallocations, planAllocations, capAllocationsToBudget, computeAllocationBudget, type MarketLiquidity, type MarketTargetSpec, type DeallocatePlanItem, type AllocatePlanItem } from './allocation-logic.js';
import { USDS, IRM_ADAPTIVE, MORPHO_BLUE, SUSDS, markets, morphoBlueAbi, susdsAbi, encodeMarketParams, computeMarketId, computeCollateralCapId, computeAdapterCapId } from './market-config.js';
import { parseBandConfig, computeSsrApy, assertSsrSane, type BandConfig } from './band-config.js';
import { computeBandDecisions, type MarketObservation, type BandDecision } from './band-controller.js';
import { simulateAnchor, anchorPerSecWadToApy, postTradeUtilizationWad } from './anchor-sim.js';
import { fetchActionHistory, type ActionHistoryClient } from './onchain-history.js';
import { computeEffectiveMarketCap } from './optimizer-logic.js';

// Emergency stop: BOT_PAUSED=true short-circuits the cron cycle cleanly (exit 0)
// IMMEDIATELY — before RPC_URL/mode/config validation, any of which can throw. The kill
// switch must work unconditionally, including (especially) when the rest of the env is
// broken; a bot paused BECAUSE its config is bad must not exit 1 on that bad config.
// (`log` is a hoisted function declaration, so calling it here is safe.)
if (process.env.BOT_PAUSED === 'true') {
  log('BOT_PAUSED=true — bot is paused, exiting cleanly without doing anything');
  process.exit(0);
}

// ============ CONFIGURATION ============

/**
 * Parse an optional positive-integer env var, failing loud on anything present but
 * malformed — same posture as parseTargetBps: only `/^\d+$/` values pass, so empty
 * strings, negatives, decimals, hex, and scientific notation all throw instead of
 * silently coercing. Zero is rejected too (a zero timeout/lookback masks misconfig).
 */
function parsePositiveIntEnv(raw: string | undefined, defaultValue: number, label: string): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) === 0) {
    throw new Error(`${label} must be a positive whole number, got "${raw}"`);
  }
  return Number(trimmed);
}

// RPC_URL is REQUIRED — no public-endpoint default. A silently-defaulted RPC can mask a
// misconfigured deployment behind rate limits and stale reads; fail loud instead.
if (!process.env.RPC_URL) {
  throw new Error('RPC_URL environment variable is required');
}

const config = {
  rpcUrl: process.env.RPC_URL,
  privateKey: process.env.PRIVATE_KEY as Hex,
  safeAddress: process.env.SAFE_ADDRESS as Address,
  vaultAddress: process.env.VAULT_ADDRESS as Address,
  adapterAddress: process.env.ADAPTER_ADDRESS as Address,

  // Target allocation percentages (in basis points, 10000 = 100%)
  // targetAllocatedPercent must match the sum of all markets' targetBps below.
  targetIdlePercent: 8000, // 80%
  targetAllocatedPercent: 2000, // 20%

  // Rebalance threshold - only rebalance if deviation exceeds this (in basis points).
  // bps mode only: bands mode gates on "any band target differs from the current position
  // beyond the dust floor" instead (see main).
  rebalanceThresholdBps: 10, // 0.1%

  // Minimum allocation amount (to avoid dust transactions)
  minAllocationAmount: parseEther('100'), // 100 USDS minimum

  // Optional per-market cap on how much to deallocate in a single cycle (USDS). Lets the
  // migration proceed in smaller, gentler steps. 0 (default) means no extra cap — each
  // deallocation is limited only by the target and the pool's available liquidity.
  // In bands mode MAX_DEALLOCATE_USDS is REQUIRED > 0 (enforced by parseBandConfig). The
  // band controller clamps STEERED drains to it, so this cap is redundant for those —
  // but RETIRED / winddown SWEEP decisions target 0 with NO controller-side step clamp,
  // so this per-cycle cap is the ONLY thing chunking a sweep's drain to
  // MAX_DEALLOCATE_USDS per cycle. Do not remove it as a bands-mode "no-op".
  maxDeallocatePerCycle: parseEther(process.env.MAX_DEALLOCATE_USDS || '0'),

  // Upper bound (ms) on waiting for the Safe tx receipt. A hung RPC or a stuck tx must
  // fail the run (non-zero exit) instead of blocking the cron slot indefinitely.
  receiptTimeoutMs: parsePositiveIntEnv(process.env.RECEIPT_TIMEOUT_MS, 300_000, 'RECEIPT_TIMEOUT_MS'),

  // Bands mode: how many blocks back to scan Morpho Blue Supply/Withdraw events for the
  // adapter, to resolve last-action timestamps for the direction-change cooldown.
  // 7500 blocks ~ 25h at 12s/block, just over the 24h cooldown window.
  cooldownLookbackBlocks: parsePositiveIntEnv(process.env.COOLDOWN_LOOKBACK_BLOCKS, 7500, 'COOLDOWN_LOOKBACK_BLOCKS'),

  // Dry run mode (set to true to simulate without executing)
  dryRun: process.env.DRY_RUN === 'true',
};

// ALLOCATION_MODE is REQUIRED with no default: 'bps' runs today's static-target DECISION
// logic identically (targets, sweep inference, threshold, caps, liquidity handling and
// ordering unchanged, incl. validateTargetBpsSum); 'bands' runs the Phase A
// utilization-band steering. NOTE the failure-path hardening is shared by BOTH modes and
// deliberately differs from the pre-bands code: RPC_URL is required (no public default),
// execution errors propagate to a non-zero exit (no try/catch), plus the pending-nonce
// guard and bounded receipt wait — mandated by the repo's fail-loud ground rules. Anything
// else (including unset) throws at module load — an allocator must never guess its strategy.
const allocationModeRaw = process.env.ALLOCATION_MODE;
if (allocationModeRaw !== 'bps' && allocationModeRaw !== 'bands') {
  throw new Error(`ALLOCATION_MODE is required and must be 'bps' or 'bands', got "${allocationModeRaw}"`);
}
const allocationMode: 'bps' | 'bands' = allocationModeRaw;

// Bands mode: parse the full band-steering configuration up front (throws on any invalid
// or missing-required value, e.g. MAX_ALLOCATE_USDS / MAX_DEALLOCATE_USDS must be > 0).
const bandConfig: BandConfig | undefined = allocationMode === 'bands' ? parseBandConfig(process.env) : undefined;

if (allocationMode === 'bps') {
  // Fail fast on a misconfigured strategy: the per-market targets must sum to the
  // overall allocated target, otherwise the idle/allocated split silently drifts.
  // Validated over ALL markets (not just oracle-configured ones) so that a partial
  // deployment doesn't false-positive. NOTE: a market that needs allocation OR
  // deallocation must also have its oracle set (see the m.oracle !== '0x0' filter in
  // main) — e.g. the migration requires ORACLE_WETH so WETH can be drained to 0%.
  validateTargetBpsSum(markets.map(m => ({ label: m.name, bps: m.targetBps })), config.targetAllocatedPercent);

  // Hard-fail when a retired market (targetBps === 0) has no oracle. target-0 means "this
  // market must hold nothing", but without an oracle it can't be addressed or drained, so
  // any funds it holds are stranded and the 80% idle buffer silently breaks. Unlike a
  // target>0 market with no oracle (which merely can't be funded — a non-fatal shortfall,
  // warned at runtime), this is a fund-safety issue, so we refuse to start.
  const undrainable = markets.filter(m => m.targetBps === 0 && m.oracle === '0x0');
  if (undrainable.length > 0) {
    throw new Error(
      `${undrainable.map(m => m.name).join(', ')} have targetBps=0 but no oracle configured — ` +
      `a retired market cannot be drained without its oracle. Set their ORACLE_* env vars ` +
      `(e.g. ORACLE_WETH for the migration) before running.`
    );
  }
} else {
  // Bands-mode analog of the undrainable check: static bps sums are meaningless here
  // (validateTargetBpsSum is deliberately skipped), but a RETIRED-mode market still
  // cannot be drained without its oracle (the market id derives from it), so any funds
  // it holds would be stranded. Refuse to start.
  const undrainable = markets.filter(m => m.mode === 'RETIRED' && m.oracle === '0x0');
  if (undrainable.length > 0) {
    throw new Error(
      `${undrainable.map(m => m.name).join(', ')} have mode=RETIRED but no oracle configured — ` +
      `a retired market cannot be drained without its oracle. Set their ORACLE_* env vars before running.`
    );
  }

  // The direction/feed cooldowns are reconstructed from a BOUNDED event scan
  // (COOLDOWN_LOOKBACK_BLOCKS). If the scan window is shorter than a configured cooldown,
  // events older than the window read as undefined ("no recent action") and that cooldown
  // silently stops binding — exactly the masked-misconfig failure mode the repo forbids.
  // Enforce the coupling: the window (~12s/block) must cover the longest cooldown plus a
  // 1h safety margin for block-time variance. The defaults line up exactly:
  // 7500 blocks x 12s = 90000s = 24h cooldown + 1h margin.
  const maxCooldownHours = Math.max(
    bandConfig!.directionCooldownHours,
    bandConfig!.soundingFeedCooldownHours,
  );
  const lookbackSec = config.cooldownLookbackBlocks * 12;
  const requiredSec = maxCooldownHours * 3600 + 3600;
  if (lookbackSec < requiredSec) {
    throw new Error(
      `COOLDOWN_LOOKBACK_BLOCKS=${config.cooldownLookbackBlocks} covers only ~${lookbackSec}s at 12s/block, ` +
      `but the configured cooldowns need >= ${requiredSec}s ` +
      `(max(DIRECTION_COOLDOWN_HOURS, SOUNDING_FEED_COOLDOWN_HOURS) = ${maxCooldownHours}h + 1h safety margin) — ` +
      `events falling outside the scan window would silently unbind the cooldown. ` +
      `Raise COOLDOWN_LOOKBACK_BLOCKS or lower the cooldown hours.`
    );
  }
}

// parseEther accepts a leading '-', so a fat-fingered negative would silently disable the
// cap (the > 0n guard skips it). Reject it loudly instead.
if (config.maxDeallocatePerCycle < 0n) {
  throw new Error(`MAX_DEALLOCATE_USDS must be >= 0, got "${process.env.MAX_DEALLOCATE_USDS}"`);
}

// Constants
// Safe MultiSendCallOnly (v1.4.1) — matches our Safe version
const MULTISEND = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as Address;

// ============ ABIs ============

const vaultAbi = [
  {
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'isAllocator',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    // Per-id relative cap in WAD (e.g. 1e17 = 10%). capId for a collateral is
    // keccak256(abi.encode("collateralToken", collateral)). Used to clamp allocations
    // so we never exceed the on-chain cap (which would revert the whole batch).
    name: 'relativeCap',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'allocate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'adapter', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'assets', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'deallocate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'adapter', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'assets', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const adapterAbi = [
  {
    name: 'realAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'marketIdsLength',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'marketIds',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'expectedSupplyAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

// Adaptive Curve IRM: per-market rate at target utilization (per-second, WAD). Signed on
// chain (int256) but always positive in practice. Bands mode reads it as the anchor rate.
const irmAbi = [
  {
    name: 'rateAtTarget',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ type: 'int256' }],
  },
] as const;

const safeAbi = [
  {
    name: 'nonce',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getThreshold',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'isOwner',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getTransactionHash',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'execTransaction',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ============ HELPERS ============

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  }
}

/**
 * Pack multiple calls into a Safe MultiSend payload.
 * Each tx: uint8(operation=0) ++ address(to) ++ uint256(value=0) ++ uint256(dataLen) ++ bytes(data)
 */
function packMultiSendTxs(txs: { to: Address; data: Hex }[]): Hex {
  let packed = '0x';
  for (const tx of txs) {
    const data = tx.data.slice(2);
    const dataLength = data.length / 2;
    packed += '00';                                       // operation: CALL
    packed += tx.to.slice(2).toLowerCase();               // to: 20 bytes
    packed += '0'.repeat(64);                             // value: uint256(0)
    packed += dataLength.toString(16).padStart(64, '0');  // dataLength: uint256
    packed += data;                                       // data bytes
  }
  return packed as Hex;
}

/**
 * Execute a transaction through the Safe multisig.
 * Signs the Safe transaction hash using eth_sign and calls execTransaction.
 * Works for threshold=1 Safes where the bot is one of the owners.
 */
async function executeSafeTransaction(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  safeAddress: Address,
  to: Address,
  data: Hex,
  operation: number = 0, // 0 = CALL, 1 = DELEGATECALL
): Promise<Hex> {
  // Get current Safe nonce
  const nonce = await publicClient.readContract({
    address: safeAddress,
    abi: safeAbi,
    functionName: 'nonce',
  });

  // Get the Safe transaction hash to sign
  const safeTxHash = await publicClient.readContract({
    address: safeAddress,
    abi: safeAbi,
    functionName: 'getTransactionHash',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, nonce],
  });

  // Sign using eth_sign (signMessage adds "\x19Ethereum Signed Message:\n32" prefix)
  const signature = await account.signMessage({ message: { raw: safeTxHash } });

  // Adjust v value: +4 to indicate eth_sign signature type to Safe contract
  // Safe uses v > 30 to identify eth_sign signatures
  const sigBytes = hexToBytes(signature);
  sigBytes[64] += 4;
  const adjustedSig = bytesToHex(sigBytes);

  // Estimate gas with a buffer to account for state changes between estimation and execution.
  // The stUSDS market is highly active (~14M TVL), so adapter.realAssets() gas cost varies
  // depending on market state at execution time vs estimation time.
  const estimatedGas = await publicClient.estimateContractGas({
    account,
    address: safeAddress,
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, adjustedSig],
  });
  const gasWithBuffer = estimatedGas * 150n / 100n; // 50% buffer

  // Execute through Safe (bot's EOA pays gas, Safe executes the inner call)
  const hash = await walletClient.writeContract({
    account,
    chain: mainnet,
    address: safeAddress,
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, adjustedSig],
    gas: gasWithBuffer,
  });

  return hash;
}

// ============ MAIN ALLOCATOR LOGIC ============

async function main() {
  log('=== Flagship Vault Allocator Bot ===');
  log(`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'} | allocation mode: ${allocationMode}`);

  // Validate configuration
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }
  if (!config.safeAddress) {
    throw new Error('SAFE_ADDRESS environment variable is required');
  }
  if (!config.vaultAddress) {
    throw new Error('VAULT_ADDRESS environment variable is required');
  }
  if (!config.adapterAddress) {
    throw new Error('ADAPTER_ADDRESS environment variable is required');
  }

  // Create clients
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(config.rpcUrl),
  });

  log(`Bot signer address: ${account.address}`);
  log(`Safe multisig address: ${config.safeAddress}`);
  log(`Vault address: ${config.vaultAddress}`);
  log(`Adapter address: ${config.adapterAddress}`);

  // Pending-nonce guard: if the bot EOA still has a transaction in flight from a previous
  // run (pending nonce ahead of latest), submitting another would stack behind or replace
  // it. Fail loud; the next cron cycle retries once the mempool clears.
  const [pendingNonce, latestNonce] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
  ]);
  if (pendingNonce > latestNonce) {
    throw new Error(
      `previous tx in flight: bot EOA ${account.address} pending nonce ${pendingNonce} > latest ${latestNonce}`
    );
  }

  // Verify bot is an owner of the Safe
  const isOwner = await publicClient.readContract({
    address: config.safeAddress,
    abi: safeAbi,
    functionName: 'isOwner',
    args: [account.address],
  });
  if (!isOwner) {
    throw new Error(`Bot signer ${account.address} is not an owner of Safe ${config.safeAddress}`);
  }

  // Verify Safe threshold is 1 (so bot can execute autonomously)
  const threshold = await publicClient.readContract({
    address: config.safeAddress,
    abi: safeAbi,
    functionName: 'getThreshold',
  });
  if (threshold !== 1n) {
    throw new Error(`Safe threshold is ${threshold}, expected 1. Bot cannot execute autonomously.`);
  }
  log('Safe ownership and threshold verified (1/3 multisig)');

  // Check if the Safe is an allocator on the vault
  const isAllocator = await publicClient.readContract({
    address: config.vaultAddress,
    abi: vaultAbi,
    functionName: 'isAllocator',
    args: [config.safeAddress],
  });

  if (!isAllocator) {
    throw new Error(`Safe ${config.safeAddress} is not an allocator for this vault`);
  }
  log('Allocator permission verified (Safe is allocator)');

  // Get current state
  const [totalAssets, adapterAssets, vaultIdleBalance] = await Promise.all([
    publicClient.readContract({
      address: config.vaultAddress,
      abi: vaultAbi,
      functionName: 'totalAssets',
    }),
    publicClient.readContract({
      address: config.adapterAddress,
      abi: adapterAbi,
      functionName: 'realAssets',
    }),
    publicClient.readContract({
      address: USDS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.vaultAddress],
    }),
  ]);

  log('Current vault state:', {
    totalAssets: formatEther(totalAssets),
    adapterAssets: formatEther(adapterAssets),
    vaultIdleBalance: formatEther(vaultIdleBalance),
    currentAllocationPercent: totalAssets > 0n
      ? Number((adapterAssets * 10000n) / totalAssets) / 100
      : 0,
  });

  // Static bps targets are meaningful only in bps mode; bands mode logs its decision
  // inputs and rules via the BAND_TRACE line further down instead.
  if (allocationMode === 'bps') {
    // Calculate target allocations
    const targetTotalAllocated = (totalAssets * BigInt(config.targetAllocatedPercent)) / 10000n;

    log('Target allocations:', {
      targetTotalAllocated: formatEther(targetTotalAllocated),
      targetIdlePercent: config.targetIdlePercent / 100,
      perMarketTargetsBps: markets.map(m => `${m.name}: ${m.targetBps}`),
    });

    // Aggregate deviation is informational only. We deliberately do NOT short-circuit
    // on it: with asymmetric per-market targets (e.g. migrating 5/5/5/5 → 0/10/10/0),
    // the aggregate allocated can match targetAllocatedPercent exactly while individual
    // markets are far off target. The per-market decision (and threshold short-circuit)
    // lives in computeAllocationActions below, which is the single source of truth.
    const allocationDiff = adapterAssets > targetTotalAllocated
      ? adapterAssets - targetTotalAllocated
      : targetTotalAllocated - adapterAssets;

    const aggregateDeviationBps = totalAssets > 0n
      ? Number((allocationDiff * 10000n) / totalAssets)
      : 0;

    log(`Aggregate deviation: ${aggregateDeviationBps / 100}% (per-market threshold: ${config.rebalanceThresholdBps / 100}%)`);
  }

  // Read per-market allocations from the adapter. The target-sum invariant is
  // validated once at module load (see validateTargetBpsSum above).
  const configuredMarkets = markets.filter(m => m.oracle !== '0x0');
  for (const market of configuredMarkets) {
    market.encodedParams = encodeMarketParams(market);
  }

  // Any market without an oracle is filtered out above and is therefore entirely
  // ignored — neither allocated to nor deallocated from. This is a silent footgun:
  //  - a positive-target market would never be funded; and
  //  - critically, a target-0 market that STILL HOLDS funds (e.g. WETH mid-migration)
  //    can never be drained, so the migration stalls forever with no signal.
  // We cannot detect the held-funds case on-chain — a market's id is derived from its
  // oracle, so an oracle-less market can't even be addressed or balance-read. The only
  // available signal is the missing oracle itself, so warn loudly for every such market
  // regardless of target. The sum invariant (validateTargetBpsSum) cannot catch this.
  const oracleless = markets.filter(m => m.oracle === '0x0');
  if (oracleless.length > 0) {
    log(`WARNING: ${oracleless.map(m => `${m.name} (target ${m.targetBps} bps)`).join(', ')} ` +
        `have no oracle configured and will be IGNORED — not allocated to, and (if they hold funds) ` +
        `not deallocated from, so the strategy/migration cannot complete. Set their ORACLE_* env vars.`);
  }

  // The module-load validateTargetBpsSum check covers ALL markets, but the engine only
  // operates on the oracle-configured subset. If those targets don't sum to the overall
  // allocated target, the difference stays idle — quantify the shortfall so the gap the
  // oracle warning describes is visible as a number, not just a list of markets.
  // (bps mode only: bands mode has no static target sum to compare against.)
  if (allocationMode === 'bps') {
    const configuredTargetSum = configuredMarkets.reduce((sum, m) => sum + m.targetBps, 0);
    if (configuredTargetSum !== config.targetAllocatedPercent) {
      log(`WARNING: oracle-configured markets' targets sum to ${configuredTargetSum} bps, but ` +
          `targetAllocatedPercent is ${config.targetAllocatedPercent} bps — ` +
          `${config.targetAllocatedPercent - configuredTargetSum} bps (of totalAssets) will remain unallocated.`);
    }
  }

  const marketIds = configuredMarkets.map(m => computeMarketId(m));
  const perMarketAssets = await Promise.all(
    marketIds.map(id =>
      publicClient.readContract({
        address: config.adapterAddress,
        abi: adapterAbi,
        functionName: 'expectedSupplyAssets',
        args: [id],
      }),
    ),
  );

  log('Per-market allocations:');
  for (let i = 0; i < configuredMarkets.length; i++) {
    log(`  ${configuredMarkets[i].name}: ${formatEther(perMarketAssets[i])} USDS`);
  }

  // ---- Bands mode: read steering inputs, compute band decisions (bps mode leaves these
  // undefined and the legacy static-target path below runs unchanged). ----
  let bandTargetAmounts: bigint[] | undefined;
  let bandSweeps: boolean[] | undefined;
  let bandUtilByIndex: (number | undefined)[] | undefined;

  if (allocationMode === 'bands') {
    const cfg = bandConfig!; // parsed at module load whenever allocationMode === 'bands'

    // Pin every steering read to one block for a consistent snapshot (same pattern as
    // optimize.ts): market totals, anchor rates, caps, SSR, the vault's totalAssets and
    // the adapter's per-market positions must all describe the same instant, or the band
    // inversion (targetVault = vaultAssets + targetSupplyTotal - totalSupplyAssets) mixes
    // snapshots and mis-sizes actions by whatever lands between the reads. totalAssets and
    // perMarketAssets were read above at 'latest' for logging/bps use; bands RE-reads both
    // here at the pinned block and uses only the pinned values for its decisions.
    const block = await publicClient.getBlock();
    const at = { blockNumber: block.number } as const;
    const nowSec = Number(block.timestamp);

    const [marketStatesRaw, ratesAtTarget, collateralCapsWad, ssrRay, pinnedTotalAssets, pinnedPerMarketAssets] = await Promise.all([
      Promise.all(marketIds.map(id =>
        publicClient.readContract({ address: MORPHO_BLUE, abi: morphoBlueAbi, functionName: 'market', args: [id], ...at }))),
      Promise.all(marketIds.map(id =>
        publicClient.readContract({ address: IRM_ADAPTIVE, abi: irmAbi, functionName: 'rateAtTarget', args: [id], ...at }))),
      Promise.all(configuredMarkets.map(m =>
        publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: 'relativeCap', args: [computeCollateralCapId(m)], ...at }))),
      publicClient.readContract({ address: SUSDS, abi: susdsAbi, functionName: 'ssr', ...at }),
      publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: 'totalAssets', ...at }),
      Promise.all(marketIds.map(id =>
        publicClient.readContract({ address: config.adapterAddress, abi: adapterAbi, functionName: 'expectedSupplyAssets', args: [id], ...at }))),
    ]);

    // SSR sanity: abort the run entirely when the read APY falls outside the configured
    // bounds — a bad oracle/RPC value must not steer funds.
    const ssrApy = computeSsrApy(ssrRay);
    assertSsrSane(ssrApy, cfg);
    log(`SSR APY: ${(ssrApy * 100).toFixed(3)}% (ssr ray ${ssrRay})`);

    // Last bot action per market from Morpho Blue Supply/Withdraw events (onBehalf =
    // adapter), feeding the 24h direction-change cooldown. fetchActionHistory THROWS on
    // any RPC failure, aborting the cycle — steering blind to recent actions could
    // ping-pong funds across the cooldown.
    const fromBlock = block.number > BigInt(config.cooldownLookbackBlocks)
      ? block.number - BigInt(config.cooldownLookbackBlocks)
      : 0n;
    // Cast per ActionHistoryClient's contract: any viem PublicClient satisfies the
    // structural subset, but the generic getLogs signatures don't unify nominally.
    const history = await fetchActionHistory(publicClient as unknown as ActionHistoryClient, {
      morphoBlue: MORPHO_BLUE,
      adapter: config.adapterAddress,
      marketIds,
      fromBlock,
      toBlock: block.number,
    });

    // Accrue each market to the pinned block's timestamp via the blue-sdk Market, which
    // also advances rateAtTarget per the Adaptive Curve IRM. Same construction as
    // optimizer-logic's toSdkMarket (module-private there, so restated here).
    const accruedAnchorPerSecWadByIndex: bigint[] = [];
    const observations: MarketObservation[] = configuredMarkets.map((m, i) => {
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketStatesRaw[i];
      const accrued = new Market({
        params: new MarketParams({ loanToken: USDS, collateralToken: m.collateral, oracle: m.oracle, irm: IRM_ADAPTIVE, lltv: m.lltv }),
        totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares,
        lastUpdate, fee,
        rateAtTarget: ratesAtTarget[i],
      }).accrueInterest(block.timestamp);
      // rateAtTarget is optional on the SDK type but always defined here: the Market was
      // constructed with it and accrueInterest carries the end rate forward.
      const anchorPerSecWad = accrued.rateAtTarget!;
      accruedAnchorPerSecWadByIndex.push(anchorPerSecWad);
      const hist = history.get(marketIds[i].toLowerCase());
      return {
        index: i,
        name: m.name,
        mode: m.mode,
        maturityUtcSec: m.maturityUtcSec,
        ssrTMarginBps: m.ssrTMarginBps,
        totalSupplyAssets: accrued.totalSupplyAssets,
        totalBorrowAssets: accrued.totalBorrowAssets,
        vaultAssets: pinnedPerMarketAssets[i],
        supplyApy: accrued.getSupplyApy(block.timestamp),
        anchorApy: anchorPerSecWadToApy(anchorPerSecWad),
        effectiveCap: computeEffectiveMarketCap(pinnedTotalAssets, collateralCapsWad[i], m.absoluteCap),
        lastAllocateAtSec: hist?.lastAllocateAtSec,
        lastDeallocateAtSec: hist?.lastDeallocateAtSec,
      };
    });

    const decisions: BandDecision[] = computeBandDecisions({ markets: observations, cfg, ssrApy, totalAssets: pinnedTotalAssets, nowSec });

    // Re-index decisions by market position, failing loud on gaps or duplicates — a
    // malformed decision vector must never silently leave a market unsteered.
    bandTargetAmounts = new Array<bigint>(configuredMarkets.length);
    bandSweeps = new Array<boolean>(configuredMarkets.length);
    bandUtilByIndex = new Array<number | undefined>(configuredMarkets.length);
    const seen = new Set<number>();
    for (const d of decisions) {
      if (d.index < 0 || d.index >= configuredMarkets.length || seen.has(d.index)) {
        throw new Error(`computeBandDecisions returned an invalid or duplicate market index: ${d.index}`);
      }
      seen.add(d.index);
      bandTargetAmounts[d.index] = d.targetAmount;
      bandSweeps[d.index] = d.sweep;
      bandUtilByIndex[d.index] = d.bandUtilBps;
    }
    if (seen.size !== configuredMarkets.length) {
      throw new Error(`computeBandDecisions returned ${seen.size} decisions for ${configuredMarkets.length} markets`);
    }

    // A/B borrower-reaction bracket (LOG-ONLY in v1, no veto): for each market with an
    // action, project the anchor 24h ahead as if utilization held at the post-trade
    // level. simulateAnchor takes explicit segments and must not merge/split them (wExp
    // drift is segmentation-dependent); one 24h segment IS this bracket's definition.
    // postTradeUtilizationWad clamps the projection into [0, WAD]: a sweep or cap-forced
    // drain can exceed the pool's idle liquidity, pushing the RAW post-trade util past
    // 100%, but the real withdraw is liquidity-capped — and a diagnostics-only bracket
    // must never be able to abort the cycle (simulateAnchor throws outside [0, WAD]).
    const bigintsAsStrings = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    const bracket = decisions
      .filter(d => d.targetAmount !== observations[d.index].vaultAssets)
      .map(d => {
        const obs = observations[d.index];
        const delta = d.targetAmount - obs.vaultAssets;
        const postSupply = obs.totalSupplyAssets + delta;
        const postUtilWad = postTradeUtilizationWad(postSupply, obs.totalBorrowAssets);
        const projectedPerSecWad = simulateAnchor(
          accruedAnchorPerSecWadByIndex[d.index],
          [{ utilizationWad: postUtilWad, durationSec: 86400n }],
        );
        return {
          index: d.index,
          name: obs.name,
          postTradeUtilWad: postUtilWad,
          anchorApyNow: obs.anchorApy,
          anchorApyIn24h: anchorPerSecWadToApy(projectedPerSecWad),
        };
      });

    // Full decision trace as one grep-able JSON line. configSha256 fingerprints the
    // PARSED BandConfig (not raw env), so any effective-parameter change shows up.
    const configSha256 = createHash('sha256').update(JSON.stringify(cfg, bigintsAsStrings)).digest('hex');
    console.log('BAND_TRACE ' + JSON.stringify({
      block: block.number,
      ts: block.timestamp,
      ssrApy,
      configSha256,
      decisions: decisions.map(d => ({
        index: d.index,
        name: observations[d.index].name,
        rule: d.rule,
        reasons: d.reasons,
        targetAmount: d.targetAmount,
        bandUtilBps: d.bandUtilBps,
        sweep: d.sweep,
      })),
      bracket,
    }, bigintsAsStrings));

    // Bands-mode rebalance gate: act iff any band target differs from the current
    // (pinned-snapshot) position beyond the dust floor. (The band controller already
    // applied its own min-action, deadband, and cooldown gates — this is just
    // "anything left to do?".)
    const anyActionable = decisions.some(d => {
      const current = pinnedPerMarketAssets[d.index];
      const diff = d.targetAmount > current ? d.targetAmount - current : current - d.targetAmount;
      return diff >= config.minAllocationAmount;
    });
    if (!anyActionable) {
      log('No band actions needed (all band targets within the dust floor of current positions)');
      return;
    }
  }

  // Compute effective per-market target AMOUNTS. This applies PT-sUSDS's 5M absolute cap and
  // redistributes any overflow equally to the overflowReceiver markets (cbBTC, wstETH), so the
  // targets can't be expressed as static bps once the cap binds. computeAllocationActions
  // consumes these amounts; the base bps are still passed for the target-0 retired-sweep logic.
  const targetSpecs: MarketTargetSpec[] = configuredMarkets.map(m => ({
    baseBps: m.targetBps,
    absoluteCap: m.absoluteCap,
    overflowReceiver: m.overflowReceiver,
  }));
  const effectiveTargetAmounts = computeEffectiveTargetAmounts(totalAssets, targetSpecs);

  const cappedMarkets = configuredMarkets.filter(m =>
    m.absoluteCap !== undefined && (totalAssets * BigInt(m.targetBps)) / 10000n > m.absoluteCap);
  if (allocationMode === 'bps' && cappedMarkets.length > 0) {
    log('Effective targets (absolute cap applied, overflow redistributed):',
      configuredMarkets.map((m, i) => `${m.name}: ${formatEther(effectiveTargetAmounts[i])} USDS`));
  }

  // Compute per-market allocation/deallocation actions
  const targetPerMarketBpsByIndex = configuredMarkets.map(m => m.targetBps);
  const result = computeAllocationActions({
    totalAssets,
    perMarketAssets,
    targetPerMarketBpsByIndex,
    // bands mode: absolute per-market targets straight from the band decisions.
    // bps mode: bps-derived amounts with PT-sUSDS's absolute cap redistributed.
    targetPerMarketAmountsByIndex: bandTargetAmounts ?? effectiveTargetAmounts,
    // bands mode: sweeps are decision-driven (RETIRED / maturity winddown) rather than
    // inferred from targetBps; undefined in bps mode preserves the legacy inference.
    sweepByIndex: bandSweeps,
    // bands mode already gated on "any target beyond the dust floor" above, so the bps
    // deviation threshold is disabled there.
    rebalanceThresholdBps: allocationMode === 'bands' ? 0 : config.rebalanceThresholdBps,
    // Sweep retired (target-0) markets down to the dust floor even when their deviation
    // is below the bps threshold, so leftover funds are returned to the vault rather than
    // stranded just under the rebalance threshold.
    minSweepAmount: config.minAllocationAmount,
  });

  if (result.skipped) {
    log(`No actions needed (${result.reason})`);
    return;
  }

  // Separate deallocations and allocations
  const deallocateActions = result.actions.filter(a => a.action === 'deallocate');
  const allocateActions = result.actions.filter(a => a.action === 'allocate');

  // Optionally cap each deallocation to a smaller per-cycle size for a gentler migration.
  // (Liquidity capping below still applies on top of this.)
  if (config.maxDeallocatePerCycle > 0n) {
    for (const a of deallocateActions) {
      if (a.amount > config.maxDeallocatePerCycle) {
        log(`  ${configuredMarkets[a.marketIndex].name}: limiting deallocate to ${formatEther(config.maxDeallocatePerCycle)} per cycle (wanted ${formatEther(a.amount)})`);
        a.amount = config.maxDeallocatePerCycle;
      }
    }
  }

  // Fresh reads for allocation markets (all in parallel, single consistent snapshot)
  const freshExpectedByIndex = new Map<number, bigint>();
  // On-chain relative cap (WAD) per allocate market's collateral, to clamp allocations.
  const onchainRelativeCapWadByIndex = new Map<number, bigint>();
  let freshTotalAssets = totalAssets;
  let freshAdapterAssets = adapterAssets;
  // Effective headroom under the vault's AGGREGATE adapter cap (e.g. 20%), with headroom.
  // Allocations this cycle must keep the adapter total below this, or the batch reverts.
  let adapterAllocationCap = 0n;

  if (allocateActions.length > 0) {
    const allocateMarketIds = allocateActions.map(a => computeMarketId(configuredMarkets[a.marketIndex]));
    const allocateCapIds = allocateActions.map(a => computeCollateralCapId(configuredMarkets[a.marketIndex]));
    const [freshTotal, freshAdapter, adapterRelativeCapWad, freshExpected, relativeCaps] = await Promise.all([
      publicClient.readContract({
        address: config.vaultAddress,
        abi: vaultAbi,
        functionName: 'totalAssets',
      }),
      publicClient.readContract({
        address: config.adapterAddress,
        abi: adapterAbi,
        functionName: 'realAssets',
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: vaultAbi,
        functionName: 'relativeCap',
        args: [computeAdapterCapId(config.adapterAddress)],
      }),
      Promise.all(allocateMarketIds.map(id =>
        publicClient.readContract({
          address: config.adapterAddress,
          abi: adapterAbi,
          functionName: 'expectedSupplyAssets',
          args: [id],
        }),
      )),
      Promise.all(allocateCapIds.map(id =>
        publicClient.readContract({
          address: config.vaultAddress,
          abi: vaultAbi,
          functionName: 'relativeCap',
          args: [id],
        }),
      )),
    ]);
    freshTotalAssets = freshTotal;
    freshAdapterAssets = freshAdapter;
    const adapterCapLimit = computeCapLimit(freshTotalAssets, adapterRelativeCapWad);
    adapterAllocationCap = adapterCapLimit - adapterCapLimit * CAP_HEADROOM_BPS / 10000n;
    allocateActions.forEach((a, i) => {
      freshExpectedByIndex.set(a.marketIndex, freshExpected[i]);
      onchainRelativeCapWadByIndex.set(a.marketIndex, relativeCaps[i]);
    });
  }

  // Per-market effective cap (with headroom), computed once and reused below. The cap target is
  // the market's effective target AMOUNT (bps target with PT-sUSDS's 5M absolute cap applied and
  // overflow redistributed), clamped to the vault's live on-chain relative cap: if the on-chain
  // cap hasn't been raised to the target yet, allocating to the full target would revert
  // (RelativeCapExceeded) and, because the batch is atomic, take the deallocations down with it.
  // Clamping lets the bot allocate up to whatever cap is currently live and converge as caps rise.
  const freshEffectiveTargets = computeEffectiveTargetAmounts(freshTotalAssets, targetSpecs);
  const allocateCapInfo = allocateActions.map(a => {
    const market = configuredMarkets[a.marketIndex];
    // bands mode: the cap target is the band decision's absolute amount (computed off the
    // pinned snapshot; step caps and effectiveCap already applied by the controller).
    // bps mode: the bps target recomputed against fresh totalAssets, as before.
    const targetAmount = bandTargetAmounts !== undefined
      ? bandTargetAmounts[a.marketIndex]
      : freshEffectiveTargets[a.marketIndex];
    const onchainCapWad = onchainRelativeCapWadByIndex.get(a.marketIndex);
    const onchainCapLimit = onchainCapWad !== undefined
      ? computeCapLimit(freshTotalAssets, onchainCapWad)
      : targetAmount;
    const capLimit = onchainCapLimit < targetAmount ? onchainCapLimit : targetAmount;
    const effectiveCap = capLimit - capLimit * CAP_HEADROOM_BPS / 10000n;
    return {
      marketIndex: a.marketIndex,
      market,
      effectiveCap,
      onchainCapWad,
      targetAmount,
      clamped: onchainCapLimit < targetAmount,
    };
  });

  // Warn when a market's on-chain relative cap is below its target — allocations are
  // clamped to the live cap, so the market can't reach target until the cap is raised.
  for (const info of allocateCapInfo) {
    if (info.clamped) {
      const onchainBps = info.onchainCapWad !== undefined ? Number((info.onchainCapWad * 10000n) / 10n ** 18n) : 0;
      log(`WARNING: ${info.market.name} on-chain relative cap is ${onchainBps} bps but effective target is ` +
          `${formatEther(info.targetAmount)} USDS (${info.market.targetBps} bps base) — allocations are clamped ` +
          `to the on-chain cap. Raise the cap (increaseRelativeCap) to reach target.`);
    }
  }

  // Read available liquidity from Morpho Blue for markets we need to deallocate from.
  // If a market has high utilization (borrows ≈ supply), we can only withdraw
  // what's idle in the pool. Cap deallocate amounts to available liquidity.
  let cappedDeallocations: ReturnType<typeof capDeallocationsToLiquidity> = [];
  if (deallocateActions.length > 0) {
    const deallocateMarketIds = deallocateActions.map(a => computeMarketId(configuredMarkets[a.marketIndex]));
    const marketStates = await Promise.all(
      deallocateMarketIds.map(id =>
        publicClient.readContract({
          address: MORPHO_BLUE,
          abi: morphoBlueAbi,
          functionName: 'market',
          args: [id],
        }),
      ),
    );

    const marketLiquidityData: MarketLiquidity[] = deallocateActions.map((a, i) => {
      const [totalSupplyAssets, , totalBorrowAssets] = marketStates[i];
      // bps mode: WETH/USDS (and any market with maxUtilizationBps set) is drained only up
      // to its target utilization (93%), waiting above it; others use the flat
      // supply-reserve cushion. bands mode: the band decision's hold utilization bounds the
      // drain instead; an undefined bandUtilBps (SOUNDING / harvest grows) keeps the flat
      // cushion.
      return {
        marketIndex: a.marketIndex,
        totalSupplyAssets,
        totalBorrowAssets,
        maxUtilizationBps: bandUtilByIndex !== undefined
          ? bandUtilByIndex[a.marketIndex]
          : configuredMarkets[a.marketIndex].maxUtilizationBps,
      };
    });

    cappedDeallocations = capDeallocationsToLiquidity(deallocateActions, marketLiquidityData);
  }

  // Build vault calls: deallocations first, then allocations
  // Order matters: deallocations free up idle balance for subsequent allocations
  const vaultCalls: { name: string; action: string; amount: bigint; calldata: Hex }[] = [];

  // Plan deallocations via the pure composition, then map outcomes -> log + on-chain call.
  // cappedDeallocations is capDeallocationsToLiquidity(deallocateActions), which maps 1:1
  // in order, so cappedDeallocations[i] corresponds to deallocateActions[i] (the pre-cap
  // desired amount used for the dust decision).
  const deallocatePlan: DeallocatePlanItem[] = cappedDeallocations.map((c, i) => ({
    marketIndex: c.marketIndex,
    targetBps: configuredMarkets[c.marketIndex].targetBps,
    desired: deallocateActions[i].amount,
    cappedAmount: c.amount,
    capped: c.capped,
    skipped: c.skipped,
    availableLiquidity: c.availableLiquidity,
    // bands mode drives drain-to-zero semantics explicitly from the band decisions;
    // undefined in bps mode keeps the legacy targetBps === 0 inference.
    sweep: bandSweeps?.[c.marketIndex],
  }));

  // Deallocations execute first in the atomic batch, so by the time the allocations run the
  // adapter is lighter by this much — which is the room the allocations may use under the
  // aggregate cap.
  let totalDeallocated = 0n;
  for (const outcome of planDeallocations(deallocatePlan, config.minAllocationAmount)) {
    const market = configuredMarkets[outcome.marketIndex];
    if (outcome.status === 'skip-liquidity') {
      log(`  ${market.name}: insufficient liquidity (${formatEther(outcome.availableLiquidity)} available), skipping deallocate`);
      continue;
    }
    if (outcome.status === 'skip-dust') {
      log(`  ${market.name}: deallocate ${formatEther(outcome.desired)} below minimum (${formatEther(config.minAllocationAmount)}, target ${market.targetBps} bps), skipping`);
      continue;
    }
    if (outcome.capped) {
      log(`  ${market.name}: capping deallocate to ${formatEther(outcome.amount)} (${formatEther(outcome.availableLiquidity)} liquidity in pool)`);
    }
    totalDeallocated += outcome.amount;
    vaultCalls.push({
      name: market.name,
      action: 'deallocate',
      amount: outcome.amount,
      calldata: encodeFunctionData({
        abi: vaultAbi,
        functionName: 'deallocate',
        args: [config.adapterAddress, market.encodedParams!, outcome.amount],
      }),
    });
  }

  // Plan allocations via the pure composition. Routine "at cap" no-ops are silent (they'd
  // otherwise spam a skip line for every grown market on each sweep run); dust gaps log.
  const allocatePlan: AllocatePlanItem[] = allocateCapInfo.map(info => ({
    marketIndex: info.marketIndex,
    effectiveCap: info.effectiveCap,
    freshExpected: freshExpectedByIndex.get(info.marketIndex)!,
  }));

  const plannedAllocations: { marketIndex: number; amount: bigint }[] = [];
  for (const outcome of planAllocations(allocatePlan, config.minAllocationAmount)) {
    if (outcome.status === 'skip-atcap') continue;
    if (outcome.status === 'skip-dust') {
      const market = configuredMarkets[outcome.marketIndex];
      log(`  ${market.name}: allocate ${formatEther(outcome.gap)} below minimum (${formatEther(config.minAllocationAmount)}, target ${market.targetBps} bps), skipping`);
      continue;
    }
    plannedAllocations.push({ marketIndex: outcome.marketIndex, amount: outcome.amount });
  }

  // Constrain total allocations to the room left under the aggregate adapter cap AFTER this
  // cycle's deallocations. Each market is already within its own collateral cap, but their
  // SUM can still push the adapter past its 20% cap and revert the whole atomic batch —
  // especially when retiring markets can only be partially drained. Scale to fit; while the
  // adapter is at/over cap the budget is ~0, so the bot just deallocates and grows next cycle.
  const allocationBudget = computeAllocationBudget(adapterAllocationCap, freshAdapterAssets, totalDeallocated);
  const plannedTotal = plannedAllocations.reduce((sum, a) => sum + a.amount, 0n);
  const budgetedAllocations = capAllocationsToBudget(plannedAllocations, allocationBudget, config.minAllocationAmount);
  if (plannedTotal > allocationBudget) {
    log(`  Allocations limited by adapter cap: wanted ${formatEther(plannedTotal)}, budget ${formatEther(allocationBudget)} (adapter cap ${formatEther(adapterAllocationCap)}, adapter after deallocations ${formatEther(freshAdapterAssets - totalDeallocated)})`);
  }

  for (const { marketIndex, amount } of budgetedAllocations) {
    const market = configuredMarkets[marketIndex];
    vaultCalls.push({
      name: market.name,
      action: 'allocate',
      amount,
      calldata: encodeFunctionData({
        abi: vaultAbi,
        functionName: 'allocate',
        args: [config.adapterAddress, market.encodedParams!, amount],
      }),
    });
  }

  if (vaultCalls.length === 0) {
    // Rebalancing WAS triggered (we passed computeAllocationActions' threshold gate) but
    // every action was dropped by liquidity caps, cap limits, or the dust filter. This is
    // an anomaly, not a clean "within threshold" no-op: the rebalance/migration may be
    // BLOCKED (e.g. illiquid markets that can't be drained). Surface it loudly so the
    // cron doesn't silently spin forever without making progress.
    log('WARNING: rebalancing was triggered but ALL actions were dropped (liquidity ' +
        'constraints, cap limits, or dust filter). The rebalance/migration may be BLOCKED — ' +
        'check market liquidity and oracle configuration.');
    return;
  }

  // Log all actions
  log(`Batching ${vaultCalls.length} actions into single transaction:`);
  for (const call of vaultCalls) {
    const direction = call.action === 'allocate' ? 'to' : 'from';
    log(`  ${call.action} ${formatEther(call.amount)} USDS ${direction} ${call.name}`);
  }
  if (allocateCapInfo.length > 0) {
    const capSummary = allocateCapInfo
      .map(info => `${info.market.name}@${info.market.targetBps}bps→${formatEther(info.effectiveCap)}`)
      .join(', ');
    log(`  (effective caps: ${capSummary})`);
  }

  if (config.dryRun) {
    log('[DRY RUN] Skipping transaction');
    return;
  }

  // Pack into MultiSend and execute as single Safe transaction. Deliberately NO
  // try/catch: any execution failure (submit error, receipt timeout, revert) must
  // propagate so the process exits non-zero and the cron surfaces it, rather than
  // logging an error line and reporting success.
  const packed = packMultiSendTxs(vaultCalls.map(c => ({ to: config.vaultAddress, data: c.calldata })));
  const multiSendData = encodeFunctionData({
    abi: [{
      name: 'multiSend',
      type: 'function',
      stateMutability: 'payable',
      inputs: [{ name: 'transactions', type: 'bytes' }],
      outputs: [],
    }] as const,
    functionName: 'multiSend',
    args: [packed],
  });

  const hash = await executeSafeTransaction(
    publicClient,
    walletClient,
    account,
    config.safeAddress,
    MULTISEND,
    multiSendData,
    1, // DELEGATECALL — MultiSend runs as Safe, so vault sees msg.sender = Safe
  );

  log(`Transaction submitted via Safe: ${hash}`);

  // Bounded wait (RECEIPT_TIMEOUT_MS, default 5 min): a slow confirmation throws here
  // and fails the run; the pending-nonce guard stops the next cycle from stacking a
  // second tx behind the in-flight one.
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.receiptTimeoutMs });
  log(`Confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
  if (receipt.status !== 'success') {
    throw new Error(`Safe transaction ${hash} reverted (status: ${receipt.status})`);
  }

  // Log final state
  const [finalAdapterAssets, finalIdleBalance] = await Promise.all([
    publicClient.readContract({
      address: config.adapterAddress,
      abi: adapterAbi,
      functionName: 'realAssets',
    }),
    publicClient.readContract({
      address: USDS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.vaultAddress],
    }),
  ]);

  log('Final vault state:', {
    adapterAssets: formatEther(finalAdapterAssets),
    vaultIdleBalance: formatEther(finalIdleBalance),
    allocationPercent: totalAssets > 0n
      ? Number((finalAdapterAssets * 10000n) / totalAssets) / 100
      : 0,
  });

  log('=== Allocation complete ===');
}

// Run
main()
  .then(() => process.exit(0))
  .catch((error) => {
    log('FATAL ERROR:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
