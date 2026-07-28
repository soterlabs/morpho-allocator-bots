/**
 * Flagship Vault Allocation Optimizer CLI (read-only).
 *
 * Computes the yield-maximizing split of the vault's allocated budget across
 * the configured Morpho Blue markets and prints a rebalance proposal. Executes
 * NOTHING on-chain: no PRIVATE_KEY, no SAFE_ADDRESS. See
 * docs/superpowers/specs/2026-07-28-allocation-optimizer-port-design.md.
 *
 * Model caveat (deliberate): rates are an instantaneous snapshot. No
 * rateAtTarget drift over time and no borrower reaction to changed rates is
 * simulated. Re-run to refresh.
 *
 * Usage:
 *   npm run optimize            # human-readable report
 *   npm run optimize -- --json  # JSON report
 *
 * Env: RPC_URL, VAULT_ADDRESS, ADAPTER_ADDRESS (plus the ORACLE_* / LLTV_*
 * market vars shared with the allocator).
 */
import { createPublicClient, http, formatEther, parseEther, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import 'dotenv/config';
import { USDS, IRM_ADAPTIVE, MORPHO_BLUE, markets as marketTable, morphoBlueAbi, computeMarketId, computeCollateralCapId, computeAdapterCapId } from './market-config.js';
import { CAP_HEADROOM_BPS, computeCapLimit, type MarketLiquidity } from './allocation-logic.js';
import { optimizeAllocations, quantizeAllocationsToBps, buildRebalanceProposal, computeVaultApy, sdkRateModel, withUtilizationCeiling, TARGET_UTILIZATION_WAD, computeEffectiveMarketCap, computeReachableFloors, type OptimizerMarketState } from './optimizer-logic.js';

// Matches allocator config.targetAllocatedPercent (80% idle / 20% allocated).
const TARGET_ALLOCATED_BPS = 2000n;
// Matches allocator config.minAllocationAmount.
const MIN_ACTION_AMOUNT = parseEther('100');

const config = {
  rpcUrl: process.env.RPC_URL || 'https://eth.llamarpc.com',
  vaultAddress: process.env.VAULT_ADDRESS as Address,
  adapterAddress: process.env.ADAPTER_ADDRESS as Address,
};

const vaultReadAbi = [
  { name: 'totalAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'relativeCap', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const;

const adapterReadAbi = [
  { name: 'realAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'expectedSupplyAssets', type: 'function', stateMutability: 'view', inputs: [{ name: 'marketId', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const;

const irmAbi = [
  { name: 'rateAtTarget', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'int256' }] },
] as const;

const erc20Abi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

// 'stUSDS/USDS' -> 'TARGET_STUSDS_BPS', 'PT-sUSDS/USDS' -> 'TARGET_PTSUSDS_BPS'
// (matches the allocator's env var names; non-alphanumerics are stripped).
function envVarFor(marketName: string): string {
  return `TARGET_${marketName.split('/')[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_BPS`;
}

function fmt(amount: bigint): string {
  return Number(formatEther(amount)).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function utilPct(wad: bigint): string {
  return `${(Number(wad) / 1e16).toFixed(1)}%`;
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  if (!config.vaultAddress) throw new Error('VAULT_ADDRESS environment variable is required');
  if (!config.adapterAddress) throw new Error('ADAPTER_ADDRESS environment variable is required');

  const publicClient = createPublicClient({ chain: mainnet, transport: http(config.rpcUrl) });

  const configured = marketTable.filter(m => m.oracle !== '0x0');
  const skipped = marketTable.filter(m => m.oracle === '0x0');
  const warnings: string[] = [];
  if (skipped.length > 0) {
    warnings.push(`Markets without an oracle are EXCLUDED from optimization: ${skipped.map(m => m.name).join(', ')}. ` +
      `Set their ORACLE_* env vars to include them.`);
  }
  if (configured.length === 0) throw new Error('No market has an oracle configured');

  // Pin every read to one block for a consistent snapshot.
  const block = await publicClient.getBlock();
  const blockNumber = block.number;
  const at = { blockNumber } as const;

  const marketIds = configured.map(computeMarketId);
  const [totalAssets, adapterAssets, idleBalance, adapterCapWad, collateralCapsWad, marketStatesRaw, ratesAtTarget, perMarketAssets] = await Promise.all([
    publicClient.readContract({ address: config.vaultAddress, abi: vaultReadAbi, functionName: 'totalAssets', ...at }),
    publicClient.readContract({ address: config.adapterAddress, abi: adapterReadAbi, functionName: 'realAssets', ...at }),
    publicClient.readContract({ address: USDS, abi: erc20Abi, functionName: 'balanceOf', args: [config.vaultAddress], ...at }),
    publicClient.readContract({ address: config.vaultAddress, abi: vaultReadAbi, functionName: 'relativeCap', args: [computeAdapterCapId(config.adapterAddress)], ...at }),
    Promise.all(configured.map(m =>
      publicClient.readContract({ address: config.vaultAddress, abi: vaultReadAbi, functionName: 'relativeCap', args: [computeCollateralCapId(m)], ...at }))),
    Promise.all(marketIds.map(id =>
      publicClient.readContract({ address: MORPHO_BLUE, abi: morphoBlueAbi, functionName: 'market', args: [id], ...at }))),
    Promise.all(marketIds.map(id =>
      publicClient.readContract({ address: IRM_ADAPTIVE, abi: irmAbi, functionName: 'rateAtTarget', args: [id], ...at }))),
    Promise.all(marketIds.map(id =>
      publicClient.readContract({ address: config.adapterAddress, abi: adapterReadAbi, functionName: 'expectedSupplyAssets', args: [id], ...at }))),
  ]);

  if (totalAssets === 0n) throw new Error('Vault totalAssets is zero, nothing to optimize');

  const sumPerMarket = perMarketAssets.reduce((s, a) => s + a, 0n);
  const inconsistency = sumPerMarket > adapterAssets ? sumPerMarket - adapterAssets : adapterAssets - sumPerMarket;
  if (adapterAssets > 0n && inconsistency * 100n > adapterAssets) {
    warnings.push(`Read inconsistency: sum of per-market assets (${fmt(sumPerMarket)}) differs from adapter realAssets ` +
      `(${fmt(adapterAssets)}) by more than 1%. Some adapter position may live outside the configured markets.`);
  }

  const states: OptimizerMarketState[] = configured.map((m, i) => {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketStatesRaw[i];
    return {
      name: m.name,
      params: { loanToken: USDS, collateralToken: m.collateral, oracle: m.oracle, irm: IRM_ADAPTIVE, lltv: m.lltv },
      totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares,
      lastUpdate, fee,
      rateAtTarget: ratesAtTarget[i],
      vaultAssets: perMarketAssets[i],
      // On-chain relative cap with headroom, clamped by the off-chain absolute
      // cap where configured (PT-sUSDS 5M).
      effectiveCap: computeEffectiveMarketCap(totalAssets, collateralCapsWad[i], m.absoluteCap),
    };
  });

  const adapterCapLimit = computeCapLimit(totalAssets, adapterCapWad);
  const adapterCapEffective = adapterCapLimit - (adapterCapLimit * CAP_HEADROOM_BPS) / 10000n;
  const targetBudget = (totalAssets * TARGET_ALLOCATED_BPS) / 10000n;
  const budget = targetBudget < adapterCapEffective ? targetBudget : adapterCapEffective;

  const ts = block.timestamp;

  // Pool state per market, shared by the floors computation and the proposal.
  // A market with maxUtilizationBps set (WETH) is drained only up to that
  // utilization; others use the flat supply-reserve cushion.
  const liquidity: MarketLiquidity[] = configured.map((m, i) => ({
    marketIndex: i,
    totalSupplyAssets: marketStatesRaw[i][0],
    totalBorrowAssets: marketStatesRaw[i][2],
    maxUtilizationBps: m.maxUtilizationBps,
  }));

  // Reachable-range floors: what cannot leave each market this cycle, by exactly
  // the allocator's withdrawal rules.
  const floors = computeReachableFloors(perMarketAssets as bigint[], liquidity);

  // Greedy scores with the utilization ceiling; every displayed APY stays real.
  const scoringModel = withUtilizationCeiling(sdkRateModel);
  const result = optimizeAllocations(
    { totalAssets, budget, markets: states, blockTimestamp: ts, minAllocations: floors },
    scoringModel,
  );
  const optimalBps = quantizeAllocationsToBps(result.allocations, totalAssets);
  const currentBps = quantizeAllocationsToBps(perMarketAssets as bigint[], totalAssets);

  const currentApy = computeVaultApy(states, perMarketAssets as bigint[], totalAssets, ts, sdkRateModel);
  const optimizedApy = computeVaultApy(states, result.allocations, totalAssets, ts, sdkRateModel);

  const proposal = buildRebalanceProposal({
    current: perMarketAssets as bigint[],
    optimal: result.allocations,
    liquidity,
    minAmount: MIN_ACTION_AMOUNT,
    adapterCap: adapterCapEffective,
    adapterAssets,
  });

  // Marginal APY: what the NEXT chunk would earn in each market at its
  // suggested allocation. This ranks which cap is most worth raising.
  const chunk = budget / 200n > 0n ? budget / 200n : 1n;
  const perMarket = states.map((m, i) => {
    const now = sdkRateModel.rates(m, m.vaultAssets, ts);
    const after = sdkRateModel.rates(m, result.allocations[i], ts);
    const marginal = scoringModel.rates(m, result.allocations[i] + chunk, ts);
    const atCap = result.allocations[i] >= m.effectiveCap;
    return {
      name: m.name,
      envVar: envVarFor(m.name),
      currentAssets: m.vaultAssets,
      currentBps: currentBps[i],
      suggestedAssets: result.allocations[i],
      suggestedBps: optimalBps[i],
      utilizationNow: now.utilizationWad,
      utilizationAfter: after.utilizationWad,
      apyNow: now.supplyApy,
      apyAfter: after.supplyApy,
      marginalApy: marginal.supplyApy,
      effectiveCap: m.effectiveCap,
      atCap,
    };
  });

  if (result.idleBudget > 0n) {
    warnings.push(`${fmt(result.idleBudget)} USDS of the budget stays idle (caps or zero marginal yield). ` +
      `The suggested TARGET_*_BPS sum to ${optimalBps.reduce((s, b) => s + b, 0)} bps, NOT ${TARGET_ALLOCATED_BPS} bps. ` +
      `The allocator hard-fails unless targets sum to its targetAllocatedPercent, so lower that too before applying.`);
  }

  if (result.overBudget > 0n) {
    warnings.push(`Adapter position exceeds the aggregate-cap budget by ${fmt(result.overBudget)} USDS even after ` +
      `all liquidity-available deallocations. The proposal drains what liquidity allows; re-run after borrowers ` +
      `repay or the cap changes.`);
  }

  // Display-only conversion: Number(formatEther(...)) is lossy for very large
  // totalAssets, but this feeds a human-readable USDS/year estimate, not any
  // on-chain decision, so the precision loss is acceptable.
  const annualGainUsds = (optimizedApy - currentApy) * Number(formatEther(totalAssets));

  if (jsonMode) {
    const out = {
      blockNumber, timestamp: ts, totalAssets, idleBalance, adapterAssets,
      budget, usedBudget: result.usedBudget, idleBudget: result.idleBudget,
      currentApy, optimizedApy, annualGainUsds, perMarket, proposal, warnings,
      floors, overBudget: result.overBudget,
      model: 'instantaneous snapshot: no rateAtTarget drift, no borrower elasticity',
    };
    console.log(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }

  const line = (s = '') => console.log(s);
  line('=== Flagship Vault Allocation Optimizer (read-only) ===');
  line(`Block ${blockNumber} (${new Date(Number(ts) * 1000).toISOString()})`);
  line(`totalAssets: ${fmt(totalAssets)} USDS | idle: ${fmt(idleBalance)} | adapter: ${fmt(adapterAssets)}`);
  line(`Budget: ${fmt(budget)} USDS (min of ${Number(TARGET_ALLOCATED_BPS) / 100}% target and adapter cap headroom ${fmt(adapterCapEffective)})`);
  line(`Model: instantaneous snapshot (no rate drift, no borrower reaction); scoring capped at ${Number(TARGET_UTILIZATION_WAD) / 1e16}% utilization; allocations bounded to this cycle's reachable range. Re-run to refresh.`);
  line();
  line('Market          Current                Suggested              Util now->after     APY now->after      Marginal APY');
  for (const r of perMarket) {
    const cap = r.atCap ? ' [AT CAP]' : '';
    line(
      `${r.name.padEnd(15)} ` +
      `${`${fmt(r.currentAssets)} (${r.currentBps}bps)`.padEnd(22)} ` +
      `${`${fmt(r.suggestedAssets)} (${r.suggestedBps}bps)`.padEnd(22)} ` +
      `${`${utilPct(r.utilizationNow)}->${utilPct(r.utilizationAfter)}`.padEnd(19)} ` +
      `${`${pct(r.apyNow)}->${pct(r.apyAfter)}`.padEnd(19)} ` +
      `${pct(r.marginalApy)}${cap}`,
    );
  }
  line();
  line(`Vault APY: ${pct(currentApy)} -> ${pct(optimizedApy)} ` +
    `(${annualGainUsds >= 0 ? '+' : ''}${annualGainUsds.toLocaleString('en-US', { maximumFractionDigits: 0 })} USDS/year)`);
  if (adapterAssets < result.usedBudget) {
    line('Note: this gain includes deploying currently idle capital up to the target budget, not only the reallocation between markets.');
  }
  line();
  if (proposal.target.length === 0) {
    line('No profitable rebalance found above the dust floor. Current allocation is optimal.');
  } else {
    line('Proposed actions (target optimum):');
    for (const a of proposal.target) {
      const dir = a.action === 'allocate' ? 'to' : 'from';
      line(`  ${a.action} ${fmt(a.amount)} USDS ${dir} ${configured[a.marketIndex].name}`);
    }
    if (proposal.liquidityLimited) {
      line('Feasible now (liquidity/cap limited):');
      if (proposal.feasible.length === 0) line('  (nothing executable this cycle)');
      for (const a of proposal.feasible) {
        const dir = a.action === 'allocate' ? 'to' : 'from';
        line(`  ${a.action} ${fmt(a.amount)} USDS ${dir} ${configured[a.marketIndex].name}`);
      }
    }
    line();
    line('Suggested env targets:');
    for (const r of perMarket) line(`${r.envVar}=${r.suggestedBps}`);
    configured.forEach((m, i) => {
      if (m.absoluteCap !== undefined && states[i].effectiveCap === m.absoluteCap && result.allocations[i] >= m.absoluteCap) {
        line(`# ${m.name}: suggested allocation sits at its absolute cap (${fmt(m.absoluteCap)} USDS, ` +
          `PT_SUSDS_ABSOLUTE_CAP_USDS) - the bps above reflect the cap, not a free optimum`);
      }
    });
    for (const m of skipped) {
      line(`# ${m.name}: no oracle configured - excluded; its ${envVarFor(m.name)} keeps its current env value (${m.targetBps})`);
    }
    line(`# Reminder: the allocator requires the sum of TARGET_*_BPS over all five markets to equal its targetAllocatedPercent (2000).`);
  }
  line();
  line('Cap insights (marginal APY of the next chunk, scored at the utilization ceiling):');
  for (const r of [...perMarket].sort((a, b) => b.marginalApy - a.marginalApy)) {
    line(`  ${r.name}: ${pct(r.marginalApy)}${r.atCap ? ' [AT CAP]' : ''}`);
  }
  for (const w of warnings) line(`\nWARNING: ${w}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
