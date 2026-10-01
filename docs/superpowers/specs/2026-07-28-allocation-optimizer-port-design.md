# Allocation Optimizer port to usds-flagship - design

Date: 2026-07-28. Status: approved.

## Goal

Port the read-only allocation optimizer (`npm run optimize`) from
`morpho-vault-v2-deployment` (branch `feature/allocation-optimizer`) into
`morpho-allocator-bots/usds-flagship`. The tool computes the yield-maximizing
split of the vault's 20% allocated budget across the configured Morpho Blue
markets and prints a rebalance proposal to the console (text report and
`--json`). It executes nothing on-chain: no `PRIVATE_KEY`, no `SAFE_ADDRESS`.

Scope for this iteration: compute allocations and report them. Feeding the
result back into the allocator (automatic target updates) is out of scope.

## Context: what changed since the original

The original optimizer was built against the 4-market bot in
`morpho-vault-v2-deployment/bot`. The `usds-flagship` bot has since evolved:

- **5 markets**: stUSDS (retired, target 0), cbBTC (667 bps), wstETH (667 bps),
  PT-sUSDS (666 bps), WETH (retired, target 0).
- **PT-sUSDS absolute cap**: 5M USDS enforced off-chain by the bot
  (`PT_SUSDS_ABSOLUTE_CAP_USDS`); overflow above the cap is redistributed to
  the `overflowReceiver` markets (cbBTC, wstETH) by
  `computeEffectiveTargetAmounts`.
- **WETH max-utilization drain**: deallocations from WETH are capped so
  post-withdraw utilization stays at or below 93% (`maxUtilizationBps` on
  `MarketLiquidity`, already supported by `capDeallocationsToLiquidity`).
- No `market-config.ts`: the market table and id/cap helpers live inline in
  `allocator.ts`.
- No `@morpho-org/blue-sdk` dependency yet.

## Approach decision

**Chosen: new bot rules become bounds inside the existing greedy algorithm.**

- The PT-sUSDS absolute cap enters `effectiveCap` (min of the on-chain
  relative-cap limit with headroom and the absolute cap).
- The WETH 93%-utilization rule enters the per-market floors (funds that
  cannot leave the market this cycle).

The greedy marginal-allocation core is untouched; it just receives tighter
constraints. The `overflowReceiver` 50/50 split is deliberately NOT emulated:
the optimizer decides where surplus goes on merit, which is the very
optimization we want to see. Consequence: the optimizer's output need not
reproduce the static 667/667/666 scheme.

Rejected alternative: post-process the optimum through
`computeEffectiveTargetAmounts` (cap + overflow redistribution). That would
duplicate execution logic inside the decision tool and suppress the
optimization signal.

## Components

### 1. `src/market-config.ts` (new, extracted from `allocator.ts`)

Single source of truth shared by `allocator.ts` (writes) and `optimize.ts`
(read-only):

- Constants: `USDS`, `IRM_ADAPTIVE`, `MORPHO_BLUE`.
- `MarketConfig` interface including `absoluteCap`, `overflowReceiver`,
  `maxUtilizationBps`, `encodedParams`.
- The 5-market table with its env overrides (`ORACLE_*`, `LLTV_*`,
  `TARGET_*_BPS`, `PT_SUSDS_ABSOLUTE_CAP_USDS`, `WETH_MAX_UTILIZATION_BPS`).
- Helpers: `encodeMarketParams`, `computeMarketId`, `computeCollateralCapId`,
  `computeAdapterCapId`, `morphoBlueAbi`.

`allocator.ts` changes only in imports; the module-load validations
(`validateTargetBpsSum`, undrainable-market check, negative
`MAX_DEALLOCATE_USDS` check) stay in `allocator.ts` because they gate the
executing bot, not the read-only tool.

### 2. `src/optimizer-logic.ts` (ported, pure math, no RPC)

Ported verbatim from the original except where noted:

- `RateModel` interface with `sdkRateModel` implemented on
  `@morpho-org/blue-sdk` (`Market`, `MarketParams`, accrual, hypothetical
  vault-allocation states).
- `withUtilizationCeiling` scoring decorator (90% target utilization ceiling,
  the dominant-supplier fix). Displayed APYs always come from the real model.
- `optimizeAllocations`: greedy marginal allocation with per-market floors
  (`minAllocations`), `effectiveCap` bounds, budget chunking (default 200
  chunks), `overBudget` reporting.
- `quantizeAllocationsToBps`, `computeVaultApy`.
- `buildRebalanceProposal`: reuses `capDeallocationsToLiquidity`,
  `computeAllocationBudget`, `capAllocationsToBudget` from the local
  `allocation-logic.ts`. **Delta**: `ProposalInput.liquidity` entries carry
  `maxUtilizationBps` so the feasible set respects the WETH drain rule.

### 3. `src/optimize.ts` (ported CLI)

- Reads on-chain state pinned to a single block: `totalAssets`, adapter
  `realAssets`, vault idle balance, adapter aggregate relative cap, per-market
  collateral relative caps, Morpho market states, `rateAtTarget` per market,
  per-market `expectedSupplyAssets`.
- Markets without an oracle are excluded with a warning; hard fail when none
  is configured, when `VAULT_ADDRESS`/`ADAPTER_ADDRESS` are missing, or when
  `totalAssets` is zero.
- `effectiveCap` per market = min(on-chain relative-cap limit with
  `CAP_HEADROOM_BPS`, `absoluteCap` when set). PT-sUSDS therefore never gets a
  proposal above 5M.
- Floors are computed by running a hypothetical full-position deallocation per
  market through `capDeallocationsToLiquidity` and reading the capped result:
  one semantics shared with the allocator (flat `LIQUIDITY_RESERVE_PERCENT`
  cushion, or the `maxUtilizationBps` rule where set) instead of a duplicated
  formula.
- Budget = min(20% of totalAssets, adapter aggregate cap with headroom).
- Report (text and `--json`): per-market table (current vs suggested
  allocation, utilization and APY now vs after, marginal APY, AT CAP flag),
  vault APY before vs after with annual USDS delta, proposed actions
  ("target optimum" and, when liquidity/cap limited, "feasible now"),
  suggested `TARGET_*_BPS` block for all 5 markets with the sum-must-equal-2000
  reminder, cap-insights ranking, warnings (idle budget, overBudget, read
  inconsistency, excluded markets). When PT-sUSDS's optimum sits at its
  absolute cap, the suggested-targets block prints a note that the market is
  bounded by `PT_SUSDS_ABSOLUTE_CAP_USDS`, not by the bps target alone.
- Model caveat stays declared in the header: instantaneous snapshot, no
  rateAtTarget drift, no borrower elasticity.

### 4. `package.json`

- Add dependency `@morpho-org/blue-sdk` (same major as the original, ^6.4.0).
- Add script `"optimize": "tsx src/optimize.ts"`.

### 5. Tests (`src/optimizer-logic.test.ts`)

Port the 30-test suite with adaptations:

- Existing cases: greedy vs brute-force within 0.1% of optimum, agreement
  with `AdaptiveCurveIrmLib` semantics via the SDK, ceiling decorator,
  quantization, proposal building, vault APY.
- New cases: `effectiveCap` honoring `absoluteCap`; floors derived through
  `capDeallocationsToLiquidity` with `maxUtilizationBps`; proposal feasibility
  under the WETH drain rule.
- The full existing `allocation-logic.test.ts` suite must keep passing
  (allocator changed only in imports).

## Error handling

Same as the original CLI: fail fast with a clear message on missing env,
zero totalAssets, or no configured oracle; warn (do not fail) on read
inconsistency above 1% between summed per-market assets and adapter
`realAssets`.

## Out of scope

- Wiring optimizer output into the allocator (automatic target updates).
- Utilization-target mode (Kacper's policy) - separate effort.
- Reward APR per market from the Morpho API.
- Any on-chain execution from the optimizer.
