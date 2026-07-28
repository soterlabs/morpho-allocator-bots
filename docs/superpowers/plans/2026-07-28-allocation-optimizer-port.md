# Allocation Optimizer Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the read-only allocation optimizer (`npm run optimize`) from `morpho-vault-v2-deployment` into `morpho-allocator-bots/usds-flagship`, adapted to the 5-market config (PT-sUSDS 5M absolute cap, WETH 93%-utilization drain rule).

**Architecture:** Extract a shared `market-config.ts` from `allocator.ts` (single source of truth), port the pure math module `optimizer-logic.ts` plus two new testable helpers (`computeEffectiveMarketCap`, `computeReachableFloors`), then port the `optimize.ts` CLI with the 5-market deltas. The greedy marginal-allocation core is untouched; the new bot rules enter only as tighter bounds (caps and floors).

**Tech Stack:** TypeScript (ESM, `"type": "module"`), viem, `@morpho-org/blue-sdk` ^6.4.0, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-07-28-allocation-optimizer-port-design.md`

## Global Constraints

- Working directory for ALL commands: `/Users/kuba/Workspace/firma-ai/sky-base/morpho-allocator-bots/usds-flagship`
- Port source (read-only, do not modify): `/Users/kuba/Workspace/firma-ai/sky-base/morpho-vault-v2-deployment/bot/src/` (branch `feature/allocation-optimizer` is already checked out there)
- ESM imports must use `.js` extensions (`./allocation-logic.js`), Node >= 18
- `@morpho-org/blue-sdk` pinned to `^6.4.0` (same major as the original)
- The optimizer executes NOTHING on-chain: no `PRIVATE_KEY`, no `SAFE_ADDRESS`
- `allocator.ts` may change ONLY in its import block and by deletion of moved code; zero behavior change
- The existing `allocation-logic.test.ts` suite must pass after every task
- All NEWLY WRITTEN comments/strings use regular hyphens (-), never em dashes; text copied verbatim from the source repo stays as-is
- Git: work on the existing branch `feature/allocation-optimizer`; commit after each task

---

### Task 1: Extract `src/market-config.ts` from `allocator.ts`

Pure refactor, no behavior change. The market table, Morpho constants, and id/cap helpers move to a shared module consumed by `allocator.ts` today and `optimize.ts` in Task 3.

**Files:**
- Create: `src/market-config.ts`
- Modify: `src/allocator.ts` (imports + deletion of moved blocks only)

**Interfaces:**
- Consumes: `parseTargetBps` from `./allocation-logic.js` (existing)
- Produces (Task 3 relies on these exact names): `USDS`, `IRM_ADAPTIVE`, `MORPHO_BLUE` (constants, `Address`); `MarketConfig` (interface with `name`, `collateral`, `oracle`, `lltv`, `targetBps`, `absoluteCap?`, `overflowReceiver?`, `maxUtilizationBps?`, `encodedParams?`); `markets: MarketConfig[]`; `morphoBlueAbi`; `encodeMarketParams(market: MarketConfig): Hex`; `computeMarketId(market: MarketConfig): Hex`; `computeCollateralCapId(market: MarketConfig): Hex`; `computeAdapterCapId(adapter: Address): Hex`

- [ ] **Step 1: Create `src/market-config.ts`**

The content below is assembled verbatim from `src/allocator.ts` (interface `MarketConfig` at lines 62-83, LLTV/oracle/cap constants at lines 85-102, `markets` table at lines 104-148, `USDS`/`IRM_ADAPTIVE`/`MORPHO_BLUE` at lines 178-181, `morphoBlueAbi` at lines 268-283, the four helper functions at lines 355-427), with `export` added and the imports it needs:

```typescript
/**
 * Shared market configuration for the usds-flagship bots.
 *
 * Single source of truth for the market table, Morpho addresses, and the
 * id/cap derivation helpers, used by both allocator.ts (writes) and
 * optimize.ts (read-only). Moved verbatim from allocator.ts.
 */
import { encodeFunctionData, encodeAbiParameters, keccak256, parseEther, type Address, type Hex } from 'viem';
import { parseTargetBps } from './allocation-logic.js';

// Constants
export const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F' as Address;
export const IRM_ADAPTIVE = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC' as Address;
export const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;

// Market configurations - loaded from environment
export interface MarketConfig {
  name: string;
  collateral: Address;
  oracle: Address;
  lltv: bigint;
  // Per-market target allocation in basis points (10000 = 100%).
  // Sum across all configured markets must equal config.targetAllocatedPercent.
  targetBps: number;
  // Optional absolute cap (in USDS) on this market's allocated amount, enforced off-chain by
  // the bot (not a market/vault param). When the bps target exceeds this, the market is held
  // at the cap and the overflow is redistributed to overflowReceiver markets. Used by
  // PT-sUSDS/USDS (5M cap).
  absoluteCap?: bigint;
  // When true, this market absorbs an equal share of overflow from absolute-capped markets on
  // top of its own bps target. Set on cbBTC/USDS and wstETH/USDS to soak up PT-sUSDS overflow.
  overflowReceiver?: boolean;
  // Optional max utilization (bps) for deallocations from this market. When set, withdrawals
  // are capped so post-withdraw utilization stays <= this (and skipped/waited once already
  // at/above it) instead of the flat supply-reserve cushion. Set on WETH/USDS (9300 = 93%).
  maxUtilizationBps?: number;
  encodedParams?: Hex;
}

// Most markets use 86% LLTV per BA Labs recommendation (02/02/2026). PT-sUSDS/USDS uses 91.5%.
const LLTV_86_PERCENT = '860000000000000000';
const LLTV_91_5_PERCENT = '915000000000000000';

// Existing stUSDS oracle from USDS vault deployment
const EXISTING_STUSDS_ORACLE = '0x0A976226d113B67Bd42D672Ac9f83f92B44b454C';
// PT-sUSDS/USDS market oracle (MorphoChainlinkOracleV2). See soterlabs/morpho-market-pt-susds.
const PT_SUSDS_ORACLE = '0xda5901EF31ecAFa6561B2e56B4997FAdd3dB4646';

// PT-sUSDS/USDS absolute allocation cap (5M USDS), enforced off-chain by the bot. When the
// market's bps target exceeds this, PT-sUSDS is held at 5M and the overflow is split equally
// between cbBTC/USDS and wstETH/USDS. Override via env PT_SUSDS_ABSOLUTE_CAP_USDS.
const PT_SUSDS_ABSOLUTE_CAP = parseEther(process.env.PT_SUSDS_ABSOLUTE_CAP_USDS || '5000000');

// Max utilization (bps) the bot will push a drained market to when withdrawing. WETH/USDS is
// being retired to 0%; we withdraw only up to 93% utilization and wait above it. Override via
// env WETH_MAX_UTILIZATION_BPS.
const WETH_MAX_UTILIZATION_BPS = parseTargetBps(process.env.WETH_MAX_UTILIZATION_BPS, 9300, 'WETH_MAX_UTILIZATION_BPS');

// Per-market target defaults (basis points). Override via env vars. Current scheme retires
// stUSDS and WETH to 0% and splits the 20% allocated target across cbBTC/wstETH/PT-sUSDS
// (~6.66% each: 667/667/666, so the five-market sum is exactly 2000). PT-sUSDS
// is additionally bounded by its 5M absolute cap, with overflow going to cbBTC and wstETH.
export const markets: MarketConfig[] = [
  {
    name: 'stUSDS/USDS',
    collateral: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9' as Address,
    oracle: (process.env.ORACLE_STUSDS || EXISTING_STUSDS_ORACLE) as Address,
    lltv: BigInt(process.env.LLTV_STUSDS || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_STUSDS_BPS, 0, 'TARGET_STUSDS_BPS'),
  },
  {
    name: 'cbBTC/USDS',
    collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address,
    oracle: (process.env.ORACLE_CBBTC || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_CBBTC || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_CBBTC_BPS, 667, 'TARGET_CBBTC_BPS'),
    overflowReceiver: true,
  },
  {
    name: 'wstETH/USDS',
    collateral: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address,
    oracle: (process.env.ORACLE_WSTETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WSTETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WSTETH_BPS, 667, 'TARGET_WSTETH_BPS'),
    overflowReceiver: true,
  },
  {
    name: 'PT-sUSDS/USDS',
    collateral: '0xdC169AbE56461A2E0c034Da431Ac2a3ebf596094' as Address,
    oracle: (process.env.ORACLE_PTSUSDS || PT_SUSDS_ORACLE) as Address,
    lltv: BigInt(process.env.LLTV_PTSUSDS || LLTV_91_5_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_PTSUSDS_BPS, 666, 'TARGET_PTSUSDS_BPS'),
    absoluteCap: PT_SUSDS_ABSOLUTE_CAP,
  },
  {
    name: 'WETH/USDS',
    collateral: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    oracle: (process.env.ORACLE_WETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WETH_BPS, 0, 'TARGET_WETH_BPS'),
    maxUtilizationBps: WETH_MAX_UTILIZATION_BPS,
  },
];

export const morphoBlueAbi = [
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

export function encodeMarketParams(market: MarketConfig): Hex {
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

export function computeMarketId(market: MarketConfig): Hex {
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
export function computeCollateralCapId(market: MarketConfig): Hex {
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
export function computeAdapterCapId(adapter: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], ['this', adapter]));
}
```

- [ ] **Step 2: Update `src/allocator.ts` to consume the new module**

Delete the moved blocks from `src/allocator.ts` (they must not exist twice):
- `interface MarketConfig { ... }` (lines 61-83, including the `// Market configurations - loaded from environment` comment)
- `LLTV_86_PERCENT`, `LLTV_91_5_PERCENT`, `EXISTING_STUSDS_ORACLE`, `PT_SUSDS_ORACLE`, `PT_SUSDS_ABSOLUTE_CAP`, `WETH_MAX_UTILIZATION_BPS` constants (lines 85-102)
- `const markets: MarketConfig[] = [ ... ];` including its leading comment (lines 104-148)
- `const USDS = ...`, `const IRM_ADAPTIVE = ...`, `const MORPHO_BLUE = ...` (lines 178-181, keep the `// Constants` comment above `MULTISEND` if it reads naturally, keep `MULTISEND` itself)
- `const morphoBlueAbi = [ ... ] as const;` (lines 268-283)
- The four functions `encodeMarketParams`, `computeMarketId`, `computeCollateralCapId`, `computeAdapterCapId` with their doc comments (lines 355-427, keep `ZERO_ADDRESS` and `log`)

Replace the import block at the top of `src/allocator.ts` (lines 26-30) with:

```typescript
import { createPublicClient, createWalletClient, http, formatEther, parseEther, encodeFunctionData, hexToBytes, bytesToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import 'dotenv/config';
import { computeAllocationActions, computeCapLimit, CAP_HEADROOM_BPS, capDeallocationsToLiquidity, validateTargetBpsSum, computeEffectiveTargetAmounts, planDeallocations, planAllocations, capAllocationsToBudget, computeAllocationBudget, type MarketLiquidity, type MarketTargetSpec, type DeallocatePlanItem, type AllocatePlanItem } from './allocation-logic.js';
import { USDS, IRM_ADAPTIVE, MORPHO_BLUE, markets, morphoBlueAbi, encodeMarketParams, computeMarketId, computeCollateralCapId, computeAdapterCapId } from './market-config.js';
```

(Dropped from the old imports because their only users moved: `encodeAbiParameters`, `keccak256` from viem and `parseTargetBps` from allocation-logic.)

The module-load validations (`validateTargetBpsSum(...)`, the `undrainable` check, the `maxDeallocatePerCycle < 0n` check) STAY in `allocator.ts` - they gate the executing bot, not the read-only tool.

- [ ] **Step 3: Verify no behavior change**

Run: `npm run build && npm test`
Expected: `tsc` clean; the full existing `allocation-logic.test.ts` suite passes (same count as before the change; run `npm test` once before editing if you want the baseline number).

- [ ] **Step 4: Commit**

```bash
git add src/market-config.ts src/allocator.ts
git commit -m "refactor(usds-flagship): extract shared market-config from allocator"
```

---

### Task 2: Port `optimizer-logic.ts` with new cap/floor helpers and tests

**Files:**
- Create: `src/optimizer-logic.ts` (port + 2 new functions)
- Create: `src/optimizer-logic.test.ts` (port + new describes)
- Modify: `package.json` (add `@morpho-org/blue-sdk`)

**Interfaces:**
- Consumes (from `./allocation-logic.js`, all existing): `capDeallocationsToLiquidity`, `computeAllocationBudget`, `capAllocationsToBudget`, `computeCapLimit`, `CAP_HEADROOM_BPS`, `type MarketLiquidity`, `type AllocationAction`
- Produces (Task 3 relies on these exact signatures):
  - everything the original module exported: `sdkRateModel: RateModel`, `withUtilizationCeiling(model: RateModel, ceilingWad?: bigint): RateModel`, `TARGET_UTILIZATION_WAD: bigint`, `optimizeAllocations(input: OptimizeInput, model: RateModel): OptimizeResult`, `quantizeAllocationsToBps(allocations: bigint[], totalAssets: bigint): number[]`, `buildRebalanceProposal(input: ProposalInput): RebalanceProposal`, `computeVaultApy(markets, allocations, totalAssets, timestampSec, model): number`, types `OptimizerMarketState`, `MarketRates`, `RateModel`, `OptimizeInput`, `OptimizeResult`, `ProposalInput`, `RebalanceProposal`
  - NEW: `computeEffectiveMarketCap(totalAssets: bigint, relativeCapWad: bigint, absoluteCap?: bigint): bigint`
  - NEW: `computeReachableFloors(vaultAssets: bigint[], liquidity: MarketLiquidity[]): bigint[]` (requires `liquidity[i].marketIndex === i`)

- [ ] **Step 1: Add the SDK dependency**

Run: `npm install @morpho-org/blue-sdk@^6.4.0`
Expected: `package.json` gains the dependency, lockfile updates, no peer errors.

- [ ] **Step 2: Copy the test file and add the new failing tests**

```bash
cp /Users/kuba/Workspace/firma-ai/sky-base/morpho-vault-v2-deployment/bot/src/optimizer-logic.test.ts src/optimizer-logic.test.ts
```

Then apply two edits to `src/optimizer-logic.test.ts`:

(a) Extend the optimizer-logic import (line 4) with the two new helpers - replace:

```typescript
import { sdkRateModel, optimizeAllocations, quantizeAllocationsToBps, buildRebalanceProposal, computeVaultApy, withUtilizationCeiling, TARGET_UTILIZATION_WAD, type OptimizerMarketState, type RateModel, type OptimizeInput, type ProposalInput } from './optimizer-logic.js';
```

with:

```typescript
import { sdkRateModel, optimizeAllocations, quantizeAllocationsToBps, buildRebalanceProposal, computeVaultApy, withUtilizationCeiling, TARGET_UTILIZATION_WAD, computeEffectiveMarketCap, computeReachableFloors, type OptimizerMarketState, type RateModel, type OptimizeInput, type ProposalInput } from './optimizer-logic.js';
```

(b) Append at the end of the file:

```typescript
describe('computeEffectiveMarketCap', () => {
  it('applies CAP_HEADROOM_BPS to the relative-cap limit', () => {
    // 10% of 10M = 1M; minus 1 bps headroom.
    const cap = computeEffectiveMarketCap(eth('10000000'), 100000000000000000n);
    expect(cap).toBe(eth('1000000') - eth('1000000') / 10000n);
  });

  it('clamps to the absolute cap when it is lower than the relative limit', () => {
    // 10% of 100M = 10M; the 5M absolute cap wins.
    const cap = computeEffectiveMarketCap(eth('100000000'), 100000000000000000n, eth('5000000'));
    expect(cap).toBe(eth('5000000'));
  });

  it('ignores an absolute cap above the relative limit', () => {
    // 10% of 10M = 1M (with headroom); the 5M absolute cap is not binding.
    const cap = computeEffectiveMarketCap(eth('10000000'), 100000000000000000n, eth('5000000'));
    expect(cap).toBe(eth('1000000') - eth('1000000') / 10000n);
  });
});

describe('computeReachableFloors', () => {
  it('flat-reserve market: floor is the position minus (liquidity - 5% reserve)', () => {
    // Pool: 1000 supply, 900 borrowed -> 100 liquidity, reserve 50 -> 50 withdrawable.
    const floors = computeReachableFloors(
      [eth('200')],
      [{ marketIndex: 0, totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('900') }],
    );
    expect(floors).toEqual([eth('150')]);
  });

  it('fully-withdrawable position has a zero floor', () => {
    const floors = computeReachableFloors(
      [eth('100')],
      [{ marketIndex: 0, totalSupplyAssets: eth('10000'), totalBorrowAssets: eth('1000') }],
    );
    expect(floors).toEqual([0n]);
  });

  it('maxUtilizationBps market: floor respects the post-withdraw utilization target', () => {
    // supply 1000, borrow 900, max util 93%: min remaining supply = ceil(borrow / 0.93),
    // withdrawable = supply - that; the floor is the position minus withdrawable.
    const supply = eth('1000');
    const borrow = eth('900');
    const minSupplyAfter = (borrow * 10000n + 9299n) / 9300n;
    const withdrawable = supply - minSupplyAfter;
    const floors = computeReachableFloors(
      [eth('500')],
      [{ marketIndex: 0, totalSupplyAssets: supply, totalBorrowAssets: borrow, maxUtilizationBps: 9300 }],
    );
    expect(floors).toEqual([eth('500') - withdrawable]);
  });

  it('market already above maxUtilizationBps: nothing withdrawable, floor is the full position', () => {
    // util 95% > 93% -> capDeallocationsToLiquidity skips (wait for repayments).
    const floors = computeReachableFloors(
      [eth('500')],
      [{ marketIndex: 0, totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('950'), maxUtilizationBps: 9300 }],
    );
    expect(floors).toEqual([eth('500')]);
  });
});

describe('buildRebalanceProposal with maxUtilizationBps (WETH drain rule)', () => {
  it('caps feasible deallocations by the utilization rule, not the flat reserve', () => {
    // Market 1 at 95% utilization with maxUtilizationBps 9300: nothing withdrawable,
    // so the target proposes the shift but the feasible set holds no deallocation.
    const p = buildRebalanceProposal(proposalInput({
      optimal: [eth('900'), eth('100')],
      liquidity: [
        { marketIndex: 0, totalSupplyAssets: eth('100000'), totalBorrowAssets: eth('50000') },
        { marketIndex: 1, totalSupplyAssets: eth('1000'), totalBorrowAssets: eth('950'), maxUtilizationBps: 9300 },
      ],
    }));
    expect(p.target.length).toBe(2);
    expect(p.feasible.some(a => a.action === 'deallocate')).toBe(false);
    expect(p.liquidityLimited).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/optimizer-logic.test.ts`
Expected: FAIL - cannot resolve `./optimizer-logic.js` (the module does not exist yet).

- [ ] **Step 4: Copy the implementation and add the two helpers**

```bash
cp /Users/kuba/Workspace/firma-ai/sky-base/morpho-vault-v2-deployment/bot/src/optimizer-logic.ts src/optimizer-logic.ts
```

Then apply two edits to `src/optimizer-logic.ts`:

(a) Extend the allocation-logic import (line 10) - replace:

```typescript
import { capDeallocationsToLiquidity, computeAllocationBudget, capAllocationsToBudget, type MarketLiquidity, type AllocationAction } from './allocation-logic.js';
```

with:

```typescript
import { capDeallocationsToLiquidity, computeAllocationBudget, capAllocationsToBudget, computeCapLimit, CAP_HEADROOM_BPS, type MarketLiquidity, type AllocationAction } from './allocation-logic.js';
```

(b) Append at the end of the file:

```typescript
/**
 * Effective optimizer bound for one market: the on-chain relative-cap limit with
 * CAP_HEADROOM_BPS headroom, further clamped by the market's off-chain absolute
 * cap when one is configured (e.g. PT-sUSDS's 5M USDS).
 */
export function computeEffectiveMarketCap(totalAssets: bigint, relativeCapWad: bigint, absoluteCap?: bigint): bigint {
  const capLimit = computeCapLimit(totalAssets, relativeCapWad);
  const withHeadroom = capLimit - (capLimit * CAP_HEADROOM_BPS) / 10000n;
  return absoluteCap !== undefined && absoluteCap < withHeadroom ? absoluteCap : withHeadroom;
}

/**
 * Per-market lower bounds for this cycle: the part of the vault's position that
 * cannot be withdrawn right now. Derived by running a hypothetical full-position
 * deallocation through capDeallocationsToLiquidity, so the semantics (flat
 * LIQUIDITY_RESERVE_PERCENT cushion, or the maxUtilizationBps rule where set)
 * are exactly the allocator's. Requires liquidity[i].marketIndex === i.
 */
export function computeReachableFloors(vaultAssets: bigint[], liquidity: MarketLiquidity[]): bigint[] {
  const fullWithdrawals: AllocationAction[] = vaultAssets.map((amount, i) => ({ marketIndex: i, action: 'deallocate' as const, amount }));
  const capped = capDeallocationsToLiquidity(fullWithdrawals, liquidity);
  return vaultAssets.map((amount, i) => {
    const withdrawable = capped[i].skipped ? 0n : capped[i].amount;
    return amount - withdrawable;
  });
}
```

Note: `AllocationAction` was previously a type-only import; it is now also used as a value type annotation, which is still type-only usage - no import change needed beyond (a).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/optimizer-logic.test.ts`
Expected: PASS - all ported describes (sdkRateModel, optimizeAllocations, quantizeAllocationsToBps, buildRebalanceProposal, computeVaultApy, withUtilizationCeiling, minAllocations floors) plus the three new describes.

Run: `npm run build && npm test`
Expected: `tsc` clean; the FULL suite (allocation-logic + optimizer-logic) passes.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/optimizer-logic.ts src/optimizer-logic.test.ts
git commit -m "feat(usds-flagship): port optimizer logic with absolute-cap and utilization-floor helpers"
```

---

### Task 3: Port the `optimize.ts` CLI with the 5-market deltas

**Files:**
- Create: `src/optimize.ts`
- Modify: `package.json` (add `optimize` script)
- Modify: `README.md` (usage section)

**Interfaces:**
- Consumes: Task 1's `market-config.js` exports; Task 2's `optimizer-logic.js` exports including `computeEffectiveMarketCap` and `computeReachableFloors`; `CAP_HEADROOM_BPS`, `computeCapLimit`, `type MarketLiquidity` from `./allocation-logic.js`
- Produces: the `npm run optimize` CLI (report to stdout, `--json` mode). Nothing else imports this file.

- [ ] **Step 1: Copy the CLI source**

```bash
cp /Users/kuba/Workspace/firma-ai/sky-base/morpho-vault-v2-deployment/bot/src/optimize.ts src/optimize.ts
```

- [ ] **Step 2: Apply the 5-market deltas to `src/optimize.ts`**

Six edits, in file order:

**(2a) Header comment** - replace the spec reference line inside the top doc comment:

```
 * NOTHING on-chain: no PRIVATE_KEY, no SAFE_ADDRESS. See
 * docs/superpowers/specs/2026-07-20-allocation-optimizer-design.md.
```

with:

```
 * NOTHING on-chain: no PRIVATE_KEY, no SAFE_ADDRESS. See
 * docs/superpowers/specs/2026-07-28-allocation-optimizer-port-design.md.
```

**(2b) Imports** - replace:

```typescript
import { CAP_HEADROOM_BPS, computeCapLimit, LIQUIDITY_RESERVE_PERCENT, type MarketLiquidity } from './allocation-logic.js';
import { optimizeAllocations, quantizeAllocationsToBps, buildRebalanceProposal, computeVaultApy, sdkRateModel, withUtilizationCeiling, TARGET_UTILIZATION_WAD, type OptimizerMarketState } from './optimizer-logic.js';
```

with:

```typescript
import { CAP_HEADROOM_BPS, computeCapLimit, type MarketLiquidity } from './allocation-logic.js';
import { optimizeAllocations, quantizeAllocationsToBps, buildRebalanceProposal, computeVaultApy, sdkRateModel, withUtilizationCeiling, TARGET_UTILIZATION_WAD, computeEffectiveMarketCap, computeReachableFloors, type OptimizerMarketState } from './optimizer-logic.js';
```

(`LIQUIDITY_RESERVE_PERCENT` is no longer referenced here; the floors math moved into `computeReachableFloors`. The `market-config.js` import line from the source copies over unchanged - Task 1 produced identical export names.)

**(2c) envVarFor** - PT-sUSDS's name contains a hyphen, which the allocator's env names strip. Replace:

```typescript
// 'stUSDS/USDS' -> 'TARGET_STUSDS_BPS' (matches the allocator's env var names).
function envVarFor(marketName: string): string {
  return `TARGET_${marketName.split('/')[0].toUpperCase()}_BPS`;
}
```

with:

```typescript
// 'stUSDS/USDS' -> 'TARGET_STUSDS_BPS', 'PT-sUSDS/USDS' -> 'TARGET_PTSUSDS_BPS'
// (matches the allocator's env var names; non-alphanumerics are stripped).
function envVarFor(marketName: string): string {
  return `TARGET_${marketName.split('/')[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_BPS`;
}
```

**(2d) Per-market effectiveCap honors the absolute cap** - in the `states` mapping, replace:

```typescript
  const states: OptimizerMarketState[] = configured.map((m, i) => {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketStatesRaw[i];
    const capLimit = computeCapLimit(totalAssets, collateralCapsWad[i]);
    return {
      name: m.name,
      params: { loanToken: USDS, collateralToken: m.collateral, oracle: m.oracle, irm: IRM_ADAPTIVE, lltv: m.lltv },
      totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares,
      lastUpdate, fee,
      rateAtTarget: ratesAtTarget[i],
      vaultAssets: perMarketAssets[i],
      effectiveCap: capLimit - (capLimit * CAP_HEADROOM_BPS) / 10000n,
    };
  });
```

with:

```typescript
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
```

**(2e) Floors and liquidity** - the liquidity array must exist before the floors and carry `maxUtilizationBps`. Replace the floors block:

```typescript
  // Reachable-range floors: what cannot leave each market this cycle given pool
  // liquidity (same reserve cushion as the allocator's deallocation capping).
  const floors = states.map(m => {
    const liquidity = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0n;
    const reserve = (m.totalSupplyAssets * LIQUIDITY_RESERVE_PERCENT) / 100n;
    const maxWithdrawable = liquidity > reserve ? liquidity - reserve : 0n;
    return m.vaultAssets > maxWithdrawable ? m.vaultAssets - maxWithdrawable : 0n;
  });
```

with:

```typescript
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
```

AND delete the now-duplicate later definition (before `buildRebalanceProposal`):

```typescript
  const liquidity: MarketLiquidity[] = configured.map((_, i) => ({
    marketIndex: i,
    totalSupplyAssets: marketStatesRaw[i][0],
    totalBorrowAssets: marketStatesRaw[i][2],
  }));
```

**(2f) Suggested env targets block** - replace:

```typescript
    line('Suggested env targets:');
    for (const r of perMarket) line(`${r.envVar}=${r.suggestedBps}`);
    if (skipped.length > 0) {
      for (const m of skipped) {
        line(`# ${m.name}: no oracle configured - excluded; its ${envVarFor(m.name)} keeps its current env value (default 500)`);
      }
      line(`# Reminder: the allocator requires the sum of TARGET_*_BPS over all four markets to equal its targetAllocatedPercent.`);
    }
```

with:

```typescript
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
```

- [ ] **Step 3: Add the npm script**

In `package.json` `"scripts"`, after `"allocate"`, add:

```json
    "optimize": "tsx src/optimize.ts",
```

- [ ] **Step 4: Build and run the full suite**

Run: `npm run build && npm test`
Expected: `tsc` clean, all tests pass. (The CLI itself has no unit tests, matching the original; its pure parts live in optimizer-logic.)

- [ ] **Step 5: Smoke run against mainnet**

Read-only; safe to run. Uses the public default RPC unless `RPC_URL` is set (if a `.env` with `RPC_URL` exists in the folder, it is picked up automatically):

```bash
VAULT_ADDRESS=0xE15fcC81118895b67b6647BBd393182dF44E11E0 \
ADAPTER_ADDRESS=0xf94BE39e8863183Ff41194b5923627C90A34039D \
ORACLE_CBBTC=0xA5AEb90F9f122989fE69Ae6224Ed923A0caF33B4 \
ORACLE_WSTETH=0xc9A9440d1545047b2Ce3624DB425410cF2EAE292 \
ORACLE_WETH=0x76b2242ea5BE1FCBBF4206EA09601EA5aB22Af4d \
npm run optimize
```

Expected:
- A report over all 5 markets (stUSDS and PT-sUSDS oracles default in code; the three above come from env)
- PT-sUSDS suggested allocation <= 5,000,000 USDS
- Vault APY before/after line, suggested `TARGET_*_BPS` for five markets, cap-insights ranking
- Exit code 0. If the public RPC rate-limits, re-run with a dedicated `RPC_URL`.

- [ ] **Step 6: Add the README section**

In `README.md` (the usds-flagship one), after the strategy description and before the deployment/setup section, add:

```markdown
## Allocation optimizer (read-only)

Computes the yield-maximizing split of the vault's 20% allocated budget across the
configured markets and prints a rebalance proposal. It executes nothing on-chain -
no `PRIVATE_KEY` or `SAFE_ADDRESS` needed.

```bash
npm run optimize            # human-readable report
npm run optimize -- --json  # JSON report
```

Uses the same env as the allocator (`RPC_URL`, `VAULT_ADDRESS`, `ADAPTER_ADDRESS`,
`ORACLE_*`); markets without an oracle are excluded from optimization. The report
shows per-market current vs suggested allocation, utilization and APY before/after,
a "target optimum" vs "feasible now" action list, suggested `TARGET_*_BPS` values,
and a ranking of which cap is most worth raising. PT-sUSDS suggestions are bounded
by its 5M absolute cap; WETH drains respect its 93% max-utilization rule. Model:
instantaneous snapshot (no rate drift, no borrower reaction) - re-run to refresh.
```

(Adjust the fence nesting when pasting: the inner code block needs its own fences.)

- [ ] **Step 7: Commit**

```bash
git add src/optimize.ts package.json README.md
git commit -m "feat(usds-flagship): read-only allocation optimizer CLI (npm run optimize)"
```

---

## Self-review notes

- Spec coverage: market-config extraction (Task 1), optimizer-logic port + absolute-cap bound + utilization floors + tests (Task 2), CLI port with 5-market deltas + PT-sUSDS cap note + five-market reminder (Task 3), `@morpho-org/blue-sdk` + `optimize` script (Tasks 2/3). Out-of-scope items (target feedback into the allocator, utilization-target mode, reward APR) are not implemented anywhere.
- The `envVarFor` hyphen-stripping fix is REQUIRED, not cosmetic: without it the report would print `TARGET_PT-SUSDS_BPS`, which the allocator never reads.
- `computeReachableFloors` uses index-aligned `MarketLiquidity` (`marketIndex === i`); both call sites (tests, optimize.ts) build the array that way.
- Type consistency checked: `computeEffectiveMarketCap` / `computeReachableFloors` names and signatures match across Task 2 (definition, tests) and Task 3 (usage).
