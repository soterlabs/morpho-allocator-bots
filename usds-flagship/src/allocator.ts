/**
 * Flagship Vault V2 Allocator Bot
 *
 * This bot maintains the 80% idle / 20% allocated strategy for the Flagship USDS Vault.
 * It allocates across 4 markets: stUSDS, cbBTC, wstETH, WETH (all with USDS as loan token).
 * Each market has its own target in basis points (default 5% each, sum = 20%), overridable
 * via TARGET_<MARKET>_BPS env vars to support asymmetric targets / deallocation migrations.
 *
 * Transactions are executed through a Safe 1/3 multisig. The bot is one of the 3 signers
 * and can execute autonomously since the threshold is 1.
 *
 * Run as a cronjob (deployed every 6 hours, i.e. cron "0 0,6,12,18 * * *"):
 *   0 0,6,12,18 * * * cd /path/to/bot && npm run allocate >> /var/log/allocator.log 2>&1
 *
 * Environment Variables (see .env.example):
 *   - RPC_URL: Ethereum RPC endpoint
 *   - PRIVATE_KEY: Bot signer's private key (one of the Safe owners)
 *   - SAFE_ADDRESS: Safe 1/3 multisig address (set as allocator on the vault)
 *   - VAULT_ADDRESS: Flagship Vault V2 address
 *   - ADAPTER_ADDRESS: MorphoMarketV1AdapterV2 address
 */

import { createPublicClient, createWalletClient, http, formatEther, parseEther, encodeFunctionData, encodeAbiParameters, keccak256, hexToBytes, bytesToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import 'dotenv/config';
import { computeAllocationActions, computeCapLimit, bpsToWad, CAP_HEADROOM_BPS, capDeallocationsToLiquidity, parseTargetBps, validateTargetBpsSum, planDeallocations, planAllocations, capAllocationsToBudget, computeAllocationBudget, type MarketLiquidity, type DeallocatePlanItem, type AllocatePlanItem } from './allocation-logic.js';

// ============ CONFIGURATION ============

const config = {
  rpcUrl: process.env.RPC_URL || 'https://eth.llamarpc.com',
  privateKey: process.env.PRIVATE_KEY as Hex,
  safeAddress: process.env.SAFE_ADDRESS as Address,
  vaultAddress: process.env.VAULT_ADDRESS as Address,
  adapterAddress: process.env.ADAPTER_ADDRESS as Address,

  // Target allocation percentages (in basis points, 10000 = 100%)
  // targetAllocatedPercent must match the sum of all markets' targetBps below.
  targetIdlePercent: 8000, // 80%
  targetAllocatedPercent: 2000, // 20%

  // Rebalance threshold - only rebalance if deviation exceeds this (in basis points)
  rebalanceThresholdBps: 10, // 0.1%

  // Minimum allocation amount (to avoid dust transactions)
  minAllocationAmount: parseEther('100'), // 100 USDS minimum

  // Optional per-market cap on how much to deallocate in a single cycle (USDS). Lets the
  // migration proceed in smaller, gentler steps. 0 (default) means no extra cap — each
  // deallocation is limited only by the target and the pool's available liquidity.
  maxDeallocatePerCycle: parseEther(process.env.MAX_DEALLOCATE_USDS || '0'),

  // Dry run mode (set to true to simulate without executing)
  dryRun: process.env.DRY_RUN === 'true',
};

// Market configurations - loaded from environment
interface MarketConfig {
  name: string;
  collateral: Address;
  oracle: Address;
  lltv: bigint;
  // Per-market target allocation in basis points (10000 = 100%).
  // Sum across all configured markets must equal config.targetAllocatedPercent.
  targetBps: number;
  encodedParams?: Hex;
}

// All markets use 86% LLTV per BA Labs recommendation (02/02/2026)
const LLTV_86_PERCENT = '860000000000000000';

// Existing stUSDS oracle from USDS vault deployment
const EXISTING_STUSDS_ORACLE = '0x0A976226d113B67Bd42D672Ac9f83f92B44b454C';

// Per-market target defaults (basis points). Override via env vars.
// Legacy default is 500 (5%) each, matching the original 5/5/5/5 = 20% scheme.
// For the stUSDS+WETH deallocation migration, set TARGET_STUSDS_BPS=0 TARGET_WETH_BPS=0
// TARGET_CBBTC_BPS=1000 TARGET_WSTETH_BPS=1000 (sum still equals targetAllocatedPercent=2000).
const DEFAULT_TARGET_BPS = 500;
const markets: MarketConfig[] = [
  {
    name: 'stUSDS/USDS',
    collateral: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9' as Address,
    oracle: (process.env.ORACLE_STUSDS || EXISTING_STUSDS_ORACLE) as Address,
    lltv: BigInt(process.env.LLTV_STUSDS || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_STUSDS_BPS, DEFAULT_TARGET_BPS, 'TARGET_STUSDS_BPS'),
  },
  {
    name: 'cbBTC/USDS',
    collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address,
    oracle: (process.env.ORACLE_CBBTC || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_CBBTC || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_CBBTC_BPS, DEFAULT_TARGET_BPS, 'TARGET_CBBTC_BPS'),
  },
  {
    name: 'wstETH/USDS',
    collateral: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address,
    oracle: (process.env.ORACLE_WSTETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WSTETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WSTETH_BPS, DEFAULT_TARGET_BPS, 'TARGET_WSTETH_BPS'),
  },
  {
    name: 'WETH/USDS',
    collateral: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    oracle: (process.env.ORACLE_WETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WETH_BPS, DEFAULT_TARGET_BPS, 'TARGET_WETH_BPS'),
  },
];

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

// parseEther accepts a leading '-', so a fat-fingered negative would silently disable the
// cap (the > 0n guard skips it). Reject it loudly instead.
if (config.maxDeallocatePerCycle < 0n) {
  throw new Error(`MAX_DEALLOCATE_USDS must be >= 0, got "${process.env.MAX_DEALLOCATE_USDS}"`);
}

// Constants
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F' as Address;
const IRM_ADAPTIVE = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC' as Address;
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;

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

const morphoBlueAbi = [
  {
    name: 'market',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
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

function encodeMarketParams(market: MarketConfig): Hex {
  // MarketParams struct: (loanToken, collateralToken, oracle, irm, lltv)
  // This matches the Solidity struct encoding
  const encoded = encodeFunctionData({
    abi: [{
      name: 'encode',
      type: 'function',
      inputs: [{
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'loanToken', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'irm', type: 'address' },
          { name: 'lltv', type: 'uint256' },
        ],
      }],
      outputs: [],
    }],
    functionName: 'encode',
    args: [{
      loanToken: USDS,
      collateralToken: market.collateral,
      oracle: market.oracle,
      irm: IRM_ADAPTIVE,
      lltv: market.lltv,
    }],
  });

  // Remove the function selector (first 4 bytes / 10 hex chars including 0x)
  return `0x${encoded.slice(10)}` as Hex;
}

function computeMarketId(market: MarketConfig): Hex {
  const encoded = encodeAbiParameters(
    [
      { name: 'loanToken', type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'irm', type: 'address' },
      { name: 'lltv', type: 'uint256' },
    ],
    [USDS, market.collateral, market.oracle, IRM_ADAPTIVE, market.lltv],
  );
  return keccak256(encoded);
}

/**
 * Compute the vault's relative-cap id for a market's collateral token.
 * Mirrors the on-chain derivation keccak256(abi.encode("collateralToken", collateral))
 * used when the caps were configured (see test/flagship/DeployFlagshipScript.t.sol).
 */
function computeCollateralCapId(market: MarketConfig): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }],
    ['collateralToken', market.collateral],
  );
  return keccak256(encoded);
}

/**
 * Compute the vault's relative-cap id for the adapter itself (the aggregate cap covering
 * everything the adapter allocates). Mirrors keccak256(abi.encode("this", adapter)) used
 * at configuration time (see test/flagship/DeployFlagshipScript.t.sol).
 */
function computeAdapterCapId(adapter: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], ['this', adapter]));
}

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
  log(`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}`);

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
  const configuredTargetSum = configuredMarkets.reduce((sum, m) => sum + m.targetBps, 0);
  if (configuredTargetSum !== config.targetAllocatedPercent) {
    log(`WARNING: oracle-configured markets' targets sum to ${configuredTargetSum} bps, but ` +
        `targetAllocatedPercent is ${config.targetAllocatedPercent} bps — ` +
        `${config.targetAllocatedPercent - configuredTargetSum} bps (of totalAssets) will remain unallocated.`);
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

  // Compute per-market allocation/deallocation actions
  const targetPerMarketBpsByIndex = configuredMarkets.map(m => m.targetBps);
  const result = computeAllocationActions({
    totalAssets,
    perMarketAssets,
    targetPerMarketBpsByIndex,
    rebalanceThresholdBps: config.rebalanceThresholdBps,
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

  // Per-market effective cap (with headroom), computed once and reused below. Each cap is
  // clamped to the vault's on-chain relative cap: if the cap hasn't been raised to the
  // target yet, allocating to the full target would revert (RelativeCapExceeded) and,
  // because the batch is atomic, take the deallocations down with it. Clamping lets the
  // bot allocate up to whatever cap is currently live and converge as caps are raised.
  const allocateCapInfo = allocateActions.map(a => {
    const market = configuredMarkets[a.marketIndex];
    const targetCapWad = bpsToWad(market.targetBps);
    const onchainCapWad = onchainRelativeCapWadByIndex.get(a.marketIndex);
    const capWad = onchainCapWad !== undefined && onchainCapWad < targetCapWad ? onchainCapWad : targetCapWad;
    const capLimit = computeCapLimit(freshTotalAssets, capWad);
    const effectiveCap = capLimit - capLimit * CAP_HEADROOM_BPS / 10000n;
    return { marketIndex: a.marketIndex, market, effectiveCap, capWad, clamped: capWad !== targetCapWad };
  });

  // Warn when a market's on-chain relative cap is below its target — allocations are
  // clamped to the live cap, so the market can't reach target until the cap is raised.
  for (const info of allocateCapInfo) {
    if (info.clamped) {
      const onchainBps = Number((info.capWad * 10000n) / 10n ** 18n);
      log(`WARNING: ${info.market.name} on-chain relative cap is ${onchainBps} bps but target is ${info.market.targetBps} bps — ` +
          `allocations are clamped to the on-chain cap. Raise the cap (increaseRelativeCap) to reach target.`);
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
      return { marketIndex: a.marketIndex, totalSupplyAssets, totalBorrowAssets };
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
    // 6-hourly cron doesn't silently spin forever without making progress.
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

  // Pack into MultiSend and execute as single Safe transaction
  try {
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

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`Confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
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
