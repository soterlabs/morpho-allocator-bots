/**
 * Tenderly mainnet-fork simulator for the bands allocator (docs/band-steering.md).
 *
 * Runs the REAL decision pipeline — computeBandDecisions -> reconcileToVaultLimits ->
 * liquidity/budget clamps -> assertBandBatchSafe — against a Tenderly fork, executes
 * the resulting legs by impersonating the allocator Safe (no keys needed on a fork),
 * and prints the vault + market state before and after each cycle. Between cycles it
 * fast-forwards fork time so the Adaptive Curve IRM actually drifts the anchors.
 *
 *   npm run fork-sim     (env: see .env.fork-sim.example)
 *
 * Deliberate differences from the production executor (allocator.ts):
 *   - Legs are sent as individual vault.allocate/deallocate txs from the impersonated
 *     Safe instead of one atomic MultiSend. On a private fork nothing can interleave,
 *     so the end state is identical; a mid-batch revert still aborts the run loudly.
 *   - The direction cooldown is fed from an in-memory ledger of the simulator's own
 *     executed legs, not from on-chain event history: pre-fork history belongs to the
 *     production bps bot, and Tenderly forks do not reliably serve parent-chain logs.
 *     First-cycle decisions are therefore cooldown-free.
 *   - No Safe signature machinery (that path is covered by the production executor and
 *     is not what this harness tests).
 *
 * Everything else — snapshot pinning, accrual via blue-sdk, SSR sanity, band choice,
 * reconciliation, the batch guard — is the same code the bot runs.
 */

import 'dotenv/config';
import { createPublicClient, http, encodeFunctionData, formatEther, parseEther, type Address, type Hex } from 'viem';
import { Market, MarketParams } from '@morpho-org/blue-sdk';
import {
  USDS, IRM_ADAPTIVE, MORPHO_BLUE, SUSDS, markets, morphoBlueAbi, susdsAbi,
  encodeMarketParams, computeMarketId, computeCollateralCapId, computeAdapterCapId, validateBandsMarkets,
} from './market-config.js';
import { parseBandConfig, computeSsrApy, assertSsrSane } from './band-config.js';
import { computeBandDecisions, type BandDecision, type MarketObservation } from './band-controller.js';
import { reconcileToVaultLimits, type ReconcileMarket } from './reconcile.js';
import { assertBandBatchSafe, type PlannedBatchCall } from './batch-guards.js';
import { anchorPerSecWadToApy } from './anchor-sim.js';
import {
  capDeallocationsToLiquidity, computeCapLimit, computeAllocationBudget, capAllocationsToBudget,
  CAP_HEADROOM_BPS, LIQUIDITY_RESERVE_PERCENT, type MarketLiquidity, type AllocationAction,
} from './allocation-logic.js';
import { bandsCaps, toReconcileMarket } from './band-plan.js';

// Mainnet Flagship deployment (README "Roles"); overridable for other deployments.
const VAULT = (process.env.VAULT_ADDRESS || '0xE15fcC81118895b67b6647BBd393182dF44E11E0') as Address;
const ADAPTER = (process.env.ADAPTER_ADDRESS || '0xf94BE39e8863183Ff41194b5923627C90A34039D') as Address;
const SAFE = (process.env.SAFE_ADDRESS || '0xE4d5F54CE1830d5eCC49751021F306CFE7a52649') as Address;

// Mirrors allocator.ts config.targetAllocatedPercent (hardcoded 2000 there) and the
// vault's on-chain 20% aggregate adapter cap — reconciliation must agree with the chain.
const SLEEVE_CAP_BPS = 2000;

// Simulator-only knobs. Hours between cycles is deliberately larger than the production
// hourly cadence: on a fork borrowers never react, so longer gaps are what make anchor
// drift visible within a handful of cycles.
const CYCLES = Number(process.env.SIM_CYCLES || '8');
const CYCLE_HOURS = Number(process.env.SIM_CYCLE_HOURS || '6');

// Optional simulated user inflow (whole USDS), deposited into the vault before the
// first cycle. This is how a sleeve stuck ABOVE the 20% cap gets unstuck in reality:
// deposits grow totalAssets, the cap rises, and the reconciler's deposit budget opens
// (which is what lets the waterfilling feed PT-sUSDS). 0 = no inflow.
const INFLOW_USDS = parseEther(process.env.SIM_INFLOW_USDS || '0');
// Synthetic depositor. Any empty EOA works: Tenderly mints it USDS + gas directly.
const DEPOSITOR = '0x1111111111111111111111111111111111111111' as Address;

const cfg = parseBandConfig(process.env);
validateBandsMarkets(markets);

interface TenderlyCreds { key: string; account: string; project: string }

function tenderlyCreds(): TenderlyCreds {
  const key = process.env.TENDERLY_ACCESS_KEY;
  const account = process.env.TENDERLY_ACCOUNT;
  const project = process.env.TENDERLY_PROJECT;
  if (!key || !account || !project) {
    throw new Error(
      'fresh-fork mode needs TENDERLY_ACCESS_KEY (dashboard -> Account Settings -> Access Keys) ' +
      'plus TENDERLY_ACCOUNT and TENDERLY_PROJECT (the two slugs from your dashboard URL)'
    );
  }
  return { key, account, project };
}

async function tenderlyApi(creds: TenderlyCreds, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.tenderly.co/api/v1/account/${creds.account}/project/${creds.project}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': creds.key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Reset-and-reuse: the project keeps exactly ONE simulator fork (SIM_FORK_SLUG,
 * default 'bands-sim'). Each run deletes the previous run's Virtual TestNet under
 * that slug and recreates it from the LATEST mainnet block, then returns its ADMIN
 * RPC url (the public one rejects the cheatcodes this script needs:
 * tenderly_setBalance / evm_increaseTime / impersonated eth_sendTransaction).
 * Recreating beats evm_revert-style resets because a revert pins the fork to the
 * aging block it was first created at; recreation tracks live mainnet.
 */
async function createFreshFork(): Promise<string> {
  const creds = tenderlyCreds();
  const slug = process.env.SIM_FORK_SLUG || 'bands-sim';

  const listRes = await tenderlyApi(creds, 'GET', '/vnets?page=1&perPage=100');
  if (!listRes.ok) {
    throw new Error(`Tenderly VNet listing failed: HTTP ${listRes.status} — ${await listRes.text()}`);
  }
  const existing = (await listRes.json() as { id: string; slug: string }[]).filter(v => v.slug === slug);
  for (const v of existing) {
    const delRes = await tenderlyApi(creds, 'DELETE', `/vnets/${v.id}`);
    // 404 = someone already pruned it in the dashboard; anything else is a real failure.
    if (!delRes.ok && delRes.status !== 404) {
      throw new Error(`deleting previous fork '${slug}' (${v.id}) failed: HTTP ${delRes.status} — ${await delRes.text()}`);
    }
    console.log(`deleted previous fork '${slug}' (${v.id})`);
  }

  const res = await tenderlyApi(creds, 'POST', '/vnets', {
    slug,
    display_name: slug,
    fork_config: { network_id: 1, block_number: 'latest' },
    // Distinct chain id so nothing signed here can ever replay on mainnet.
    virtual_network_config: { chain_config: { chain_id: 9991 } },
    // State sync would keep pulling live mainnet state under our feet while the
    // simulation time-travels — the run must own its fork exclusively.
    sync_state_config: { enabled: false },
    explorer_page_config: { enabled: false, verification_visibility: 'src' },
  });
  if (!res.ok) {
    throw new Error(`Tenderly VNet creation failed: HTTP ${res.status} — ${await res.text()}`);
  }
  const body = await res.json() as { id?: string; rpcs?: { name?: string; url: string }[] };
  const admin = body.rpcs?.find(r => (r.name ?? '').toLowerCase().includes('admin')) ?? body.rpcs?.[0];
  if (!admin) throw new Error(`Tenderly VNet creation response had no RPC urls: ${JSON.stringify(body)}`);
  console.log(`created fork '${slug}' at latest mainnet block`);
  if (body.id) console.log(`dashboard: https://dashboard.tenderly.co/${creds.account}/${creds.project}/testnet/${body.id}`);
  return admin.url;
}

/**
 * SIM_FRESH_FORK=true (or an unset TENDERLY_RPC_URL) creates a throwaway fork per run;
 * an explicit TENDERLY_RPC_URL reuses that persistent fork, mutations and all.
 */
async function resolveRpcUrl(): Promise<string> {
  const explicit = process.env.TENDERLY_RPC_URL;
  if (explicit && process.env.SIM_FRESH_FORK !== 'true') {
    // This script sends impersonated transactions that move vault funds. A real endpoint
    // would reject them, but there is no reason to ever point it at one — refuse early.
    if (!explicit.includes('tenderly') && process.env.FORK_SIM_ALLOW_ANY_RPC !== 'true') {
      throw new Error(
        `TENDERLY_RPC_URL does not look like a Tenderly endpoint: ${explicit} — ` +
        `set FORK_SIM_ALLOW_ANY_RPC=true only if this is really a disposable fork`
      );
    }
    return explicit;
  }
  return createFreshFork();
}

// Local copies of allocator.ts's module-private ABIs (kept minimal on purpose).
const vaultAbi = [
  { name: 'totalAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    name: 'relativeCap', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'uint256' }],
  },
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
  {
    // ERC-4626 user entry point — the simulated inflow goes through the same door
    // real depositors use, so idle/totalAssets accounting stays honest.
    name: 'deposit', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
const erc20Abi = [
  {
    name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const;
const adapterAbi = [
  { name: 'realAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    name: 'expectedSupplyAssets', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'bytes32' }], outputs: [{ type: 'uint256' }],
  },
] as const;
const irmAbi = [
  {
    name: 'rateAtTarget', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'int256' }],
  },
] as const;

// Assigned in main() once the fork url is resolved (possibly freshly created).
let publicClient: ReturnType<typeof createPublicClient>;

/** Raw JSON-RPC escape hatch for Tenderly's fork-control methods. */
function rpc(method: string, params: unknown[]): Promise<unknown> {
  return publicClient.request({ method, params } as never);
}

/** Send an impersonated tx on the fork and fail loud on revert. */
async function sendAs(from: Address, to: Address, data: Hex, what: string): Promise<void> {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data, gas: '0x2DC6C0' }]) as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${what} REVERTED (tx ${hash}) — fork state and plan disagree, aborting`);
  }
}

/**
 * Deposit INFLOW_USDS into the vault as a synthetic user: mint the depositor USDS
 * and gas via Tenderly cheatcodes, then approve + ERC-4626 deposit.
 */
async function simulateInflow(amount: bigint): Promise<void> {
  console.log(`\nsimulated user inflow: depositing ${formatEther(amount)} USDS into the vault as ${DEPOSITOR}`);
  await rpc('tenderly_setBalance', [[DEPOSITOR], '0xDE0B6B3A7640000']);
  await rpc('tenderly_setErc20Balance', [USDS, DEPOSITOR, `0x${amount.toString(16)}`]);
  await sendAs(DEPOSITOR, USDS,
    encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [VAULT, amount] }),
    'USDS approve for inflow');
  await sendAs(DEPOSITOR, VAULT,
    encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [amount, DEPOSITOR] }),
    'vault deposit (inflow)');
  const totalAssets = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'totalAssets' });
  console.log(`inflow landed — vault totalAssets now ${fmtM(totalAssets)} USDS`);
}

const fmtM = (x: bigint) => `${(Number(x / 10n ** 12n) / 1e12).toFixed(3)}M`;
const fmtPct = (x: number) => `${(x * 100).toFixed(3)}%`;

interface Snapshot {
  blockNumber: bigint;
  tsSec: number;
  ssrApy: number;
  totalAssets: bigint;
  adapterAssets: bigint;
  /** Per configured market, index-aligned with `markets`. */
  supply: bigint[]; borrow: bigint[]; vaultAssets: bigint[];
  anchorApy: number[]; collateralCapWad: bigint[];
  adapterRelativeCapWad: bigint;
}

/**
 * Pin every read to one block and accrue markets to its timestamp — the same snapshot
 * discipline as computeBandPlan (allocator.ts): mixing blocks mis-sizes band inversions.
 */
async function takeSnapshot(marketIds: Hex[]): Promise<Snapshot> {
  const block = await publicClient.getBlock();
  const at = { blockNumber: block.number } as const;

  const [states, rates, caps, ssrRay, totalAssets, positions, adapterAssets, adapterRelativeCapWad] = await Promise.all([
    Promise.all(marketIds.map(id =>
      publicClient.readContract({ address: MORPHO_BLUE, abi: morphoBlueAbi, functionName: 'market', args: [id], ...at }))),
    Promise.all(marketIds.map(id =>
      publicClient.readContract({ address: IRM_ADAPTIVE, abi: irmAbi, functionName: 'rateAtTarget', args: [id], ...at }))),
    Promise.all(markets.map(m =>
      publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'relativeCap', args: [computeCollateralCapId(m)], ...at }))),
    publicClient.readContract({ address: SUSDS, abi: susdsAbi, functionName: 'ssr', ...at }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'totalAssets', ...at }),
    Promise.all(marketIds.map(id =>
      publicClient.readContract({ address: ADAPTER, abi: adapterAbi, functionName: 'expectedSupplyAssets', args: [id], ...at }))),
    publicClient.readContract({ address: ADAPTER, abi: adapterAbi, functionName: 'realAssets', ...at }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'relativeCap', args: [computeAdapterCapId(ADAPTER)], ...at }),
  ]);

  // Same invisible-position guard as the bot: every adapter dollar must map to a
  // configured market, or steering silently ignores real exposure (a wrong ORACLE_*
  // yields a different market id and a zero position, which trips this).
  const visible = positions.reduce((sum, x) => sum + x, 0n);
  const gap = adapterAssets > visible ? adapterAssets - visible : visible - adapterAssets;
  if (gap > cfg.minBandActionUsds) {
    throw new Error(
      `adapter.realAssets ${formatEther(adapterAssets)} differs from summed positions ` +
      `${formatEther(visible)} by ${formatEther(gap)} USDS — check ORACLE_* env (wrong oracle = wrong market id)`
    );
  }

  const accrued = markets.map((m, i) => {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = states[i];
    return new Market({
      params: new MarketParams({ loanToken: USDS, collateralToken: m.collateral, oracle: m.oracle, irm: IRM_ADAPTIVE, lltv: m.lltv }),
      totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares,
      lastUpdate, fee, rateAtTarget: rates[i],
    }).accrueInterest(block.timestamp);
  });

  const ssrApy = computeSsrApy(ssrRay);
  assertSsrSane(ssrApy, cfg);

  return {
    blockNumber: block.number,
    tsSec: Number(block.timestamp),
    ssrApy,
    totalAssets,
    adapterAssets,
    supply: accrued.map(m => m.totalSupplyAssets),
    borrow: accrued.map(m => m.totalBorrowAssets),
    vaultAssets: [...positions],
    anchorApy: accrued.map(m => anchorPerSecWadToApy(m.rateAtTarget!)),
    collateralCapWad: [...caps],
    adapterRelativeCapWad,
  };
}

function printState(label: string, s: Snapshot) {
  const sleeve = s.vaultAssets.reduce((sum, x) => sum + x, 0n);
  const sleeveBps = s.totalAssets > 0n ? Number((sleeve * 10000n) / s.totalAssets) : 0;
  console.log(`\n${label} — block ${s.blockNumber}, ${new Date(s.tsSec * 1000).toISOString()}`);
  console.log(`  SSR ${fmtPct(s.ssrApy)} | totalAssets ${fmtM(s.totalAssets)} | sleeve ${fmtM(sleeve)} (${(sleeveBps / 100).toFixed(2)}%) | idle ${fmtM(s.totalAssets - sleeve)}`);
  console.log('  market            mode     supply     borrow     util     anchor    satAPY   position');
  markets.forEach((m, i) => {
    const util = s.supply[i] > 0n ? Number((s.borrow[i] * 10000n) / s.supply[i]) / 100 : 0;
    const sat = 0.9 * s.anchorApy[i];
    console.log(
      `  ${m.name.padEnd(16)}  ${m.mode.padEnd(7)}  ${fmtM(s.supply[i]).padStart(8)}  ${fmtM(s.borrow[i]).padStart(8)}  ` +
      `${util.toFixed(2).padStart(6)}%  ${fmtPct(s.anchorApy[i]).padStart(7)}  ${fmtPct(sat).padStart(7)}  ${fmtM(s.vaultAssets[i]).padStart(8)}`
    );
  });
}

/** The simulator's own executed legs, feeding the direction cooldown across cycles. */
const actionLedger = new Map<number, { lastAllocateAtSec?: number; lastDeallocateAtSec?: number }>();

interface PlannedCall { marketIndex: number; action: 'allocate' | 'deallocate'; amount: bigint }

/** Decision pipeline for one cycle — the bot's computeBandPlan minus I/O plumbing. */
function planCycle(s: Snapshot): { decisions: BandDecision[]; calls: PlannedCall[]; legDeltas: bigint[] } {
  const observations: MarketObservation[] = markets.map((m, i) => ({
    index: i,
    name: m.name,
    mode: m.mode,
    ssrTMarginBps: m.ssrTMarginBps,
    totalSupplyAssets: s.supply[i],
    totalBorrowAssets: s.borrow[i],
    vaultAssets: s.vaultAssets[i],
    anchorApy: s.anchorApy[i],
    ...bandsCaps(m, s.totalAssets, s.collateralCapWad[i]),
    lastAllocateAtSec: actionLedger.get(i)?.lastAllocateAtSec,
    lastDeallocateAtSec: actionLedger.get(i)?.lastDeallocateAtSec,
  }));

  const decisions = computeBandDecisions({
    markets: observations, cfg, ssrApy: s.ssrApy, nowSec: s.tsSec, liquidityReservePercent: LIQUIDITY_RESERVE_PERCENT,
  });

  const sleeve = s.vaultAssets.reduce((sum, x) => sum + x, 0n);
  const reconcileInputs: ReconcileMarket[] = markets.map(
    (m, i) => toReconcileMarket(m, observations[i], decisions[i], cfg));
  const legs = reconcileToVaultLimits({
    markets: reconcileInputs,
    sleeveUsds: sleeve,
    totalAssets: s.totalAssets,
    sleeveFloorBps: cfg.sleeveFloorBps,
    sleeveCapBps: SLEEVE_CAP_BPS,
    minActionUsds: cfg.minBandActionUsds,
  });

  console.log('\n  decisions:');
  decisions.forEach(d => {
    console.log(`    ${markets[d.index].name.padEnd(16)} ${d.rule}`);
    d.reasons.forEach(r => console.log(`      - ${r}`));
  });
  console.log('  reconciled legs:');
  legs.forEach(leg => {
    const sign = leg.delta < 0n ? '-' : '+';
    const abs = leg.delta < 0n ? -leg.delta : leg.delta;
    console.log(`    ${markets[leg.index].name.padEnd(16)} ${sign}${formatEther(abs)} USDS${leg.note ? `  (${leg.note})` : ''}`);
  });

  // Deallocations first, liquidity-capped exactly like the executor: a drain may not
  // push utilization past the market's band; a band-less drain (cap breach) keeps the
  // flat supply-reserve cushion.
  const drainLegs = legs.filter(l => l.delta < 0n);
  const drainActions: AllocationAction[] = drainLegs.map(l => ({ marketIndex: l.index, action: 'deallocate', amount: -l.delta }));
  const drainLiquidity: MarketLiquidity[] = drainLegs.map(l => ({
    marketIndex: l.index,
    totalSupplyAssets: s.supply[l.index],
    totalBorrowAssets: s.borrow[l.index],
    maxUtilizationBps: decisions[l.index].bandUtilBps,
  }));
  const calls: PlannedCall[] = [];
  let totalDeallocated = 0n;
  for (const capped of capDeallocationsToLiquidity(drainActions, drainLiquidity)) {
    if (capped.skipped || capped.amount === 0n) {
      console.log(`    ${markets[capped.marketIndex].name}: drain skipped (liquidity ${formatEther(capped.availableLiquidity)} USDS)`);
      continue;
    }
    if (capped.capped) {
      console.log(`    ${markets[capped.marketIndex].name}: drain capped to ${formatEther(capped.amount)} by pool liquidity`);
    }
    totalDeallocated += capped.amount;
    calls.push({ marketIndex: capped.marketIndex, action: 'deallocate', amount: capped.amount });
  }

  // Allocations bounded by the room ACTUALLY freed under the aggregate adapter cap
  // (mirrors allocator.ts:1032): reconciliation counted wished withdrawals, but a
  // liquidity-capped drain frees less, and the on-chain cap would revert the excess.
  const adapterCapLimit = computeCapLimit(s.totalAssets, s.adapterRelativeCapWad);
  const adapterCap = adapterCapLimit - adapterCapLimit * CAP_HEADROOM_BPS / 10000n;
  const budget = computeAllocationBudget(adapterCap, s.adapterAssets, totalDeallocated);
  const growWishes = legs.filter(l => l.delta > 0n).map(l => ({ marketIndex: l.index, amount: l.delta }));
  const grows = capAllocationsToBudget(growWishes, budget, cfg.minBandActionUsds);
  const wishedGrow = growWishes.reduce((sum, g) => sum + g.amount, 0n);
  const grantedGrow = grows.reduce((sum, g) => sum + g.amount, 0n);
  if (grantedGrow < wishedGrow) {
    console.log(`    allocations limited by adapter cap: wanted ${formatEther(wishedGrow)}, budget ${formatEther(budget)} USDS`);
  }
  for (const g of grows) calls.push({ marketIndex: g.marketIndex, action: 'allocate', amount: g.amount });

  return { decisions, calls, legDeltas: legs.map(l => l.delta) };
}

async function executeCalls(calls: PlannedCall[], legDeltas: bigint[], s: Snapshot) {
  // The same last-line-of-defense the production executor runs: every call must be a
  // strict subset of its reconciled leg and keep the sleeve inside (or moving toward)
  // [floor, cap]. A violation here is a simulator wiring bug — abort loudly.
  assertBandBatchSafe({
    calls: calls.map((c): PlannedBatchCall => ({ marketIndex: c.marketIndex, action: c.action, amount: c.amount })),
    legDeltas,
    pinnedPerMarketAssets: s.vaultAssets,
    pinnedTotalAssets: s.totalAssets,
    sleeveFloorBps: cfg.sleeveFloorBps,
    sleeveCapBps: SLEEVE_CAP_BPS,
    maxAllocateUsds: cfg.maxAllocateUsds,
    maxDeallocateUsds: cfg.maxDeallocateUsds,
    marketNames: markets.map(m => m.name),
  });

  for (const call of calls) {
    const market = markets[call.marketIndex];
    const data = encodeFunctionData({
      abi: vaultAbi,
      functionName: call.action,
      args: [ADAPTER, encodeMarketParams(market), call.amount],
    });
    console.log(`  sending ${call.action} ${formatEther(call.amount)} USDS ${call.action === 'allocate' ? 'to' : 'from'} ${market.name} as Safe ${SAFE}`);
    await sendAs(SAFE, VAULT, data, `${call.action} on ${market.name}`);
    const ledger = actionLedger.get(call.marketIndex) ?? {};
    if (call.action === 'allocate') ledger.lastAllocateAtSec = s.tsSec;
    else ledger.lastDeallocateAtSec = s.tsSec;
    actionLedger.set(call.marketIndex, ledger);
  }
}

async function main() {
  console.log('=== bands allocator fork simulator ===');
  const rpcUrl = await resolveRpcUrl();
  publicClient = createPublicClient({ transport: http(rpcUrl) });
  console.log(`fork: ${rpcUrl}`);
  console.log(`vault ${VAULT} | adapter ${ADAPTER} | impersonated Safe ${SAFE}`);
  console.log(`${CYCLES} cycles, ${CYCLE_HOURS}h apart | step caps: +${formatEther(cfg.maxAllocateUsds)} / -${formatEther(cfg.maxDeallocateUsds)} USDS per market per cycle`);

  for (const m of markets) {
    if (m.mode !== 'RETIRED' && m.oracle.length !== 42) {
      throw new Error(`${m.name} is STEERED but its ORACLE_* env is unset — the market id would be wrong`);
    }
  }
  const marketIds = markets.map(computeMarketId);

  const chainId = await publicClient.getChainId();
  console.log(`chain id ${chainId} (Tenderly forks typically keep the parent chain id)`);
  // The impersonated Safe still pays gas on Tenderly forks — fund it once.
  await rpc('tenderly_setBalance', [[SAFE], '0xDE0B6B3A7640000']);

  if (INFLOW_USDS > 0n) await simulateInflow(INFLOW_USDS);

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`\n${'='.repeat(78)}\nCYCLE ${cycle}/${CYCLES}`);
    const before = await takeSnapshot(marketIds);
    printState('state BEFORE', before);

    const { calls, legDeltas } = planCycle(before);
    if (calls.length === 0) {
      console.log('  -> empty batch, nothing to execute this cycle');
    } else {
      await executeCalls(calls, legDeltas, before);
      const after = await takeSnapshot(marketIds);
      printState('state AFTER', after);
      markets.forEach((m, i) => {
        const d = after.vaultAssets[i] - before.vaultAssets[i];
        if (d !== 0n) console.log(`  ${m.name}: position ${fmtM(before.vaultAssets[i])} -> ${fmtM(after.vaultAssets[i])} (${d > 0n ? '+' : '-'}${formatEther(d < 0n ? -d : d)} USDS)`);
      });
    }

    if (cycle < CYCLES) {
      console.log(`\n  fast-forwarding ${CYCLE_HOURS}h...`);
      await rpc('evm_increaseTime', [`0x${(CYCLE_HOURS * 3600).toString(16)}`]);
      await rpc('evm_increaseBlocks', ['0x1']);
    }
  }

  console.log('\n=== simulation complete ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
