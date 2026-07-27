/**
 * USDT Savings Vault V2 Allocator Bot
 *
 * Migrates the sky.money USDT Savings vault's liquidity from the OLD sUSDS/USDT market
 * (DAI/USD oracle, uncapped USDT) to the NEW sUSDS/USDT market (USDS/USD oracle, USDT/USD
 * capped at $1.00). Both markets are USDT-denominated (6 decimals), sUSDS collateral, 96.5%
 * LLTV — they differ only by oracle.
 *
 * Each run it deallocates from the old market and allocates the same amount to the new one,
 * in a single atomic Safe transaction. The old-market withdrawal is capped so its utilization
 * never exceeds MAX_UTILIZATION_BPS (default 93%): if the old market is already at/above that,
 * the bot withdraws nothing and waits for borrowers to repay (rising rates incentivize this).
 * The migration completes on its own once the old market is drained.
 *
 * Transactions execute through a Safe multisig (threshold 1) that must be an allocator on the
 * vault; the bot is one of the Safe's owners.
 *
 * Environment Variables (see .env.example):
 *   - RPC_URL: Ethereum RPC endpoint
 *   - PRIVATE_KEY: Bot signer's private key (one of the Safe owners)
 *   - SAFE_ADDRESS: Safe multisig address (set as allocator on the vault)
 *   - VAULT_ADDRESS: USDT Savings Vault V2 address
 *   - ADAPTER_ADDRESS: MorphoMarketV1AdapterV2 address
 */

import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, encodeFunctionData, encodeAbiParameters, keccak256, hexToBytes, bytesToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import 'dotenv/config';
import { computeMigration, type MigrationInput } from './migration-logic.js';

// ============ CONFIGURATION ============

const config = {
  rpcUrl: process.env.RPC_URL || 'https://eth.llamarpc.com',
  privateKey: process.env.PRIVATE_KEY as Hex,
  safeAddress: process.env.SAFE_ADDRESS as Address,
  vaultAddress: process.env.VAULT_ADDRESS as Address,
  adapterAddress: process.env.ADAPTER_ADDRESS as Address,

  // Max utilization (bps) the bot pushes the OLD market to while withdrawing (default 93%).
  // Withdrawals are capped so post-withdraw utilization stays <= this; at/above it the bot waits.
  maxUtilizationBps: intFromEnv('MAX_UTILIZATION_BPS', 9300),

  // Dust floor (USDT) below which a migration round is skipped. USDT has 6 decimals.
  minMigrateAmount: parseUnits(process.env.MIN_MIGRATE_USDT || '100', 6),

  dryRun: process.env.DRY_RUN === 'true',
};

function intFromEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  const v = Number(t);
  if (name === 'MAX_UTILIZATION_BPS' && (v <= 0 || v > 10000)) {
    throw new Error(`${name} must be in (0, 10000] basis points, got "${raw}"`);
  }
  return v;
}

// ============ CONSTANTS ============

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address;   // loan token, 6 decimals
const SUSDS = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD' as Address;   // collateral, 18 decimals
const IRM_ADAPTIVE = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC' as Address;
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;
const MULTISEND = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as Address; // Safe MultiSendCallOnly v1.4.1
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const USDT_DECIMALS = 6;

// Both markets: USDT loan, sUSDS collateral, adaptive IRM, 96.5% LLTV — differing only by oracle.
const LLTV_96_5_PERCENT = 965000000000000000n;
// OLD market: existing sUSDS/USDT market (DAI/USD oracle, uncapped USDT).
const OLD_ORACLE = (process.env.OLD_ORACLE || '0x0C426d174FC88B7A25d59945Ab2F7274Bf7B4C79') as Address;
// NEW market: sUSDS/USDT with USDS/USD oracle and USDT/USD capped at $1.00.
const NEW_ORACLE = (process.env.NEW_ORACLE || '0x1C7DBd66dF93594bA08af8e72c75Ba2004d92F9C') as Address;

// Known market ids (asserted against the derived ids below as a config-safety check).
const OLD_MARKET_ID_KNOWN = '0x3274643db77a064abd3bc851de77556a4ad2e2f502f4f0c80845fa8f909ecf0b' as Hex;
const NEW_MARKET_ID_KNOWN = '0x26b178d49895f80ca3c39b2745efc4cd9adcddfcc73dae93e531e86977ec4d96' as Hex;

interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

const oldMarket: MarketParams = { loanToken: USDT, collateralToken: SUSDS, oracle: OLD_ORACLE, irm: IRM_ADAPTIVE, lltv: LLTV_96_5_PERCENT };
const newMarket: MarketParams = { loanToken: USDT, collateralToken: SUSDS, oracle: NEW_ORACLE, irm: IRM_ADAPTIVE, lltv: LLTV_96_5_PERCENT };

const MARKET_PARAMS_FIELDS = [
  { name: 'loanToken', type: 'address' },
  { name: 'collateralToken', type: 'address' },
  { name: 'oracle', type: 'address' },
  { name: 'irm', type: 'address' },
  { name: 'lltv', type: 'uint256' },
] as const;

// abi.encode(MarketParams) — the `data` argument for the vault's allocate/deallocate.
function encodeMarketParams(p: MarketParams): Hex {
  return encodeAbiParameters(MARKET_PARAMS_FIELDS, [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]);
}

// Morpho Blue market id = keccak256(abi.encode(MarketParams)).
function computeMarketId(p: MarketParams): Hex {
  return keccak256(encodeMarketParams(p));
}

// Fail fast if the configured params don't reproduce the known market ids (wrong oracle/LLTV
// would silently address the wrong market and move funds incorrectly).
const OLD_MARKET_ID = computeMarketId(oldMarket);
const NEW_MARKET_ID = computeMarketId(newMarket);
if (OLD_MARKET_ID.toLowerCase() !== OLD_MARKET_ID_KNOWN.toLowerCase()) {
  throw new Error(`Old market id mismatch: derived ${OLD_MARKET_ID}, expected ${OLD_MARKET_ID_KNOWN}. Check OLD_ORACLE / LLTV / token addresses.`);
}
if (NEW_MARKET_ID.toLowerCase() !== NEW_MARKET_ID_KNOWN.toLowerCase()) {
  throw new Error(`New market id mismatch: derived ${NEW_MARKET_ID}, expected ${NEW_MARKET_ID_KNOWN}. Check NEW_ORACLE / LLTV / token addresses.`);
}

// ============ ABIs ============

const vaultAbi = [
  { name: 'totalAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'isAllocator', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  {
    name: 'allocate', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'adapter', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'assets', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'deallocate', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'adapter', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'assets', type: 'uint256' }],
    outputs: [],
  },
] as const;

const adapterAbi = [
  { name: 'realAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'expectedSupplyAssets', type: 'function', stateMutability: 'view', inputs: [{ name: 'marketId', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const;

const morphoBlueAbi = [
  {
    name: 'market', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }],
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
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const safeAbi = [
  { name: 'nonce', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'getThreshold', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'isOwner', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'bool' }] },
  {
    name: 'getTransactionHash', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'execTransaction', type: 'function', stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ============ HELPERS ============

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  }
}

const usdt = (x: bigint) => `${formatUnits(x, USDT_DECIMALS)} USDT`;

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
 * Execute a transaction through the Safe multisig via eth_sign + execTransaction.
 * Works for threshold=1 Safes where the bot is one of the owners.
 */
async function executeSafeTransaction(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  safeAddress: Address,
  to: Address,
  data: Hex,
  operation: number = 0,
): Promise<Hex> {
  const nonce = await publicClient.readContract({ address: safeAddress, abi: safeAbi, functionName: 'nonce' });

  const safeTxHash = await publicClient.readContract({
    address: safeAddress, abi: safeAbi, functionName: 'getTransactionHash',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, nonce],
  });

  // eth_sign signature (Safe identifies it via v > 30, so add 4 to v).
  const signature = await account.signMessage({ message: { raw: safeTxHash } });
  const sigBytes = hexToBytes(signature);
  sigBytes[64] += 4;
  const adjustedSig = bytesToHex(sigBytes);

  const estimatedGas = await publicClient.estimateContractGas({
    account, address: safeAddress, abi: safeAbi, functionName: 'execTransaction',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, adjustedSig],
  });
  const gasWithBuffer = estimatedGas * 150n / 100n; // 50% buffer

  return walletClient.writeContract({
    account, chain: mainnet, address: safeAddress, abi: safeAbi, functionName: 'execTransaction',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, adjustedSig],
    gas: gasWithBuffer,
  });
}

// ============ MAIN ============

async function main() {
  log('=== USDT Savings Vault Allocator Bot ===');
  log(`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}`);

  if (!config.privateKey) throw new Error('PRIVATE_KEY environment variable is required');
  if (!config.safeAddress) throw new Error('SAFE_ADDRESS environment variable is required');
  if (!config.vaultAddress) throw new Error('VAULT_ADDRESS environment variable is required');
  if (!config.adapterAddress) throw new Error('ADAPTER_ADDRESS environment variable is required');

  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(config.rpcUrl) });

  log(`Bot signer address: ${account.address}`);
  log(`Safe multisig address: ${config.safeAddress}`);
  log(`Vault address: ${config.vaultAddress}`);
  log(`Adapter address: ${config.adapterAddress}`);
  log(`Old market: ${OLD_MARKET_ID}`);
  log(`New market: ${NEW_MARKET_ID}`);

  // Verify the bot can execute autonomously through the Safe.
  const isOwner = await publicClient.readContract({ address: config.safeAddress, abi: safeAbi, functionName: 'isOwner', args: [account.address] });
  if (!isOwner) throw new Error(`Bot signer ${account.address} is not an owner of Safe ${config.safeAddress}`);
  const threshold = await publicClient.readContract({ address: config.safeAddress, abi: safeAbi, functionName: 'getThreshold' });
  if (threshold !== 1n) throw new Error(`Safe threshold is ${threshold}, expected 1. Bot cannot execute autonomously.`);
  const isAllocator = await publicClient.readContract({ address: config.vaultAddress, abi: vaultAbi, functionName: 'isAllocator', args: [config.safeAddress] });
  if (!isAllocator) throw new Error(`Safe ${config.safeAddress} is not an allocator for this vault`);
  log('Safe ownership, threshold (1), and allocator permission verified');

  // Read current state: positions in each market, old-market pool liquidity, vault totals.
  const [oldPosition, newPosition, oldMarketState, adapterAssets, vaultIdle] = await Promise.all([
    publicClient.readContract({ address: config.adapterAddress, abi: adapterAbi, functionName: 'expectedSupplyAssets', args: [OLD_MARKET_ID] }),
    publicClient.readContract({ address: config.adapterAddress, abi: adapterAbi, functionName: 'expectedSupplyAssets', args: [NEW_MARKET_ID] }),
    publicClient.readContract({ address: MORPHO_BLUE, abi: morphoBlueAbi, functionName: 'market', args: [OLD_MARKET_ID] }),
    publicClient.readContract({ address: config.adapterAddress, abi: adapterAbi, functionName: 'realAssets' }),
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [config.vaultAddress] }),
  ]);

  const [oldSupply, , oldBorrow] = oldMarketState;
  const oldUtilizationPct = oldSupply > 0n ? Number((oldBorrow * 10000n) / oldSupply) / 100 : 0;

  log('Current state:', {
    oldMarketPosition: usdt(oldPosition),
    newMarketPosition: usdt(newPosition),
    oldMarketUtilization: `${oldUtilizationPct}%`,
    adapterRealAssets: usdt(adapterAssets),
    vaultIdle: usdt(vaultIdle),
    maxUtilization: `${config.maxUtilizationBps / 100}%`,
  });

  // Decide this round's migration amount (min of old position and the 93%-utilization cap).
  const migrationInput: MigrationInput = {
    oldPosition,
    oldTotalSupplyAssets: oldSupply,
    oldTotalBorrowAssets: oldBorrow,
    maxUtilizationBps: config.maxUtilizationBps,
    minAmount: config.minMigrateAmount,
  };
  const plan = computeMigration(migrationInput);

  if (plan.status === 'done') {
    log(`Migration complete — old market holds ${usdt(plan.oldPosition)} (below the ${usdt(config.minMigrateAmount)} dust floor). Nothing to do.`);
    return;
  }
  if (plan.status === 'wait-utilization') {
    log(`Old market is at/above ${config.maxUtilizationBps / 100}% utilization (${oldUtilizationPct}%) — withdrawing nothing this round and waiting for borrowers to repay.`);
    return;
  }
  if (plan.status === 'dust') {
    log(`Only ${usdt(plan.amount)} withdrawable this round (below the ${usdt(config.minMigrateAmount)} dust floor) — skipping.`);
    return;
  }

  // plan.status === 'migrate'
  const amount = plan.amount;
  if (plan.utilizationCapped) {
    log(`Withdrawal capped by ${config.maxUtilizationBps / 100}% utilization: moving ${usdt(amount)} this round (old position ${usdt(oldPosition)}, withdrawable ${usdt(plan.withdrawableByUtilization)}).`);
  } else {
    log(`Moving ${usdt(amount)} from the old market to the new market (draining the remaining old position).`);
  }

  // Atomic batch: deallocate from old, then allocate the freed idle to new.
  const vaultCalls: { name: string; calldata: Hex }[] = [
    {
      name: `deallocate ${usdt(amount)} from old market`,
      calldata: encodeFunctionData({ abi: vaultAbi, functionName: 'deallocate', args: [config.adapterAddress, encodeMarketParams(oldMarket), amount] }),
    },
    {
      name: `allocate ${usdt(amount)} to new market`,
      calldata: encodeFunctionData({ abi: vaultAbi, functionName: 'allocate', args: [config.adapterAddress, encodeMarketParams(newMarket), amount] }),
    },
  ];

  log(`Batching ${vaultCalls.length} actions into single transaction:`);
  for (const c of vaultCalls) log(`  ${c.name}`);

  if (config.dryRun) {
    log('[DRY RUN] Skipping transaction');
    return;
  }

  // Pre-flight: simulate the exact batch as the allocator Safe before submitting. Old→new is a
  // same-collateral swap so it shouldn't hit the vault's caps, but this catches any blocker
  // (market not enabled, caps not raised, or a liquidity shortfall) and turns a would-be
  // on-chain revert — which, because the batch is atomic, would otherwise just waste gas and
  // silently stall the migration — into a clear, non-zero-exit failure. This avoids guessing
  // this vault's cap-id scheme (old and new share the sUSDS collateral). Best-effort: if the
  // RPC doesn't support eth_simulateV1 we log and fall through to submission.
  try {
    const sim = await publicClient.simulateCalls({
      account: config.safeAddress,
      calls: vaultCalls.map(c => ({ to: config.vaultAddress, data: c.calldata })),
      stateOverrides: [{ address: config.safeAddress, balance: 100n * 10n ** 18n }],
    });
    const failed = sim.results.findIndex(r => r.status !== 'success');
    if (failed !== -1) {
      const r = sim.results[failed];
      const err = r.error as { shortMessage?: string; message?: string } | undefined;
      const reason = (err && (err.shortMessage || err.message)) || 'reverted';
      log(`WARNING: migration batch would revert at "${vaultCalls[failed].name}": ${reason}. ` +
          `The migration may be BLOCKED (market not enabled, caps not raised, or insufficient ` +
          `liquidity) — not submitting.`);
      process.exit(1);
    }
    log('Pre-flight simulation passed — submitting.');
  } catch (error) {
    log(`Pre-flight simulation unavailable (${(error instanceof Error ? error.message : String(error)).split('\n')[0]}); proceeding to submit.`);
  }

  const packed = packMultiSendTxs(vaultCalls.map(c => ({ to: config.vaultAddress, data: c.calldata })));
  const multiSendData = encodeFunctionData({
    abi: [{ name: 'multiSend', type: 'function', stateMutability: 'payable', inputs: [{ name: 'transactions', type: 'bytes' }], outputs: [] }] as const,
    functionName: 'multiSend',
    args: [packed],
  });

  const hash = await executeSafeTransaction(
    publicClient, walletClient, account, config.safeAddress, MULTISEND, multiSendData,
    1, // DELEGATECALL — MultiSend runs as the Safe, so the vault sees msg.sender = Safe
  );
  log(`Transaction submitted via Safe: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  log(`Confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
  // Surface an on-chain revert as a failure (non-zero exit via the outer catch) instead of a
  // silent no-op, so a blocked migration doesn't look like a successful cron run.
  if (receipt.status !== 'success') {
    throw new Error(`migration transaction ${hash} reverted on-chain (status: ${receipt.status})`);
  }

  // Final state.
  const [finalOld, finalNew] = await Promise.all([
    publicClient.readContract({ address: config.adapterAddress, abi: adapterAbi, functionName: 'expectedSupplyAssets', args: [OLD_MARKET_ID] }),
    publicClient.readContract({ address: config.adapterAddress, abi: adapterAbi, functionName: 'expectedSupplyAssets', args: [NEW_MARKET_ID] }),
  ]);
  log('Final state:', { oldMarketPosition: usdt(finalOld), newMarketPosition: usdt(finalNew) });
  log('=== Migration round complete ===');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log('FATAL ERROR:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
