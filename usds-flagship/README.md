# Flagship Vault Allocator Bot

A simple allocator bot for the Flagship USDS Vault V2 that maintains the 80% idle / 20% allocated strategy.

Transactions are executed through a **Safe 1/3 multisig**. The bot is one of the 3 signers and can execute autonomously since the threshold is 1.

## Strategy

The bot allocates vault funds according to this strategy:
- **80% idle** - Kept in the vault for immediate withdrawal liquidity
- **20% allocated** - Distributed across 5 Morpho Blue markets. Each market has its
  own target, configurable via `TARGET_<MARKET>_BPS` env vars (basis points). The current
  scheme retires stUSDS and WETH to 0% and targets ~6.66% each on the other three
  (667 / 667 / 666 = 2000):
  - stUSDS/USDS (`TARGET_STUSDS_BPS`, currently 0% — retired)
  - cbBTC/USDS (`TARGET_CBBTC_BPS`, currently 6.67%)
  - wstETH/USDS (`TARGET_WSTETH_BPS`, currently 6.67%)
  - PT-sUSDS/USDS (`TARGET_PTSUSDS_BPS`, currently 6.66%, **91.5% LLTV**)
  - WETH/USDS (`TARGET_WETH_BPS`, currently 0% — retired)

  **PT-sUSDS/USDS absolute cap.** PT-sUSDS has a 5M USDS absolute cap
  (`PT_SUSDS_ABSOLUTE_CAP_USDS`, default 5,000,000) enforced off-chain by the bot — *not* a
  market/vault param. When 6.66% of totalAssets exceeds 5M (i.e. TVL above ~75M), PT-sUSDS is
  held at 5M and the overflow is split **equally between cbBTC/USDS and wstETH/USDS** so the
  vault still reaches its 20% allocated target. (At current TVL ~38M the cap doesn't bind.)

  **WETH/USDS drain via utilization cap.** WETH is retired to 0%, but withdrawals are capped
  so post-withdraw market utilization stays ≤ `WETH_MAX_UTILIZATION_BPS` (default 9300 = 93%);
  when the market is already at/above 93% the bot withdraws nothing and waits for borrowers to
  repay. Other markets keep the flat `LIQUIDITY_RESERVE_PERCENT` (5%-of-supply) cushion.

  The sum of per-market targets must equal the 20% allocated target; the bot throws on
  startup if they don't. Asymmetric targets let the bot drive migrations — e.g.
  `TARGET_STUSDS_BPS=0 TARGET_CBBTC_BPS=1000 TARGET_WSTETH_BPS=1000 TARGET_WETH_BPS=0`
  drives stUSDS/WETH **toward** 0% and cbBTC/wstETH **toward** 10% each over successive
  runs. The bot rebalances only while a market's deviation exceeds `rebalanceThresholdBps`
  (0.1%) and skips per-action amounts below `minAllocationAmount`, so *grown* markets
  converge to within ~0.1% of target rather than landing on it exactly. **Retired
  (target-0) markets are an exception: they are swept.** A retired market still holding
  at least `minAllocationAmount` forces a rebalance even when its deviation is under the
  0.1% threshold, and the resulting deallocation is exempt from the dust filter, so its
  residual is returned to the vault down to genuine dust (< `minAllocationAmount`) rather
  than being stranded just under the threshold. Each market that is allocated to or
  drained **must also have its `ORACLE_*` env var set** — a market with no oracle is
  ignored entirely (the bot warns at startup if so).

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

## Prerequisites

- Node.js >= 20.19.0
- A Safe multisig (1/3 threshold) where the bot is one of the owners
- The **Safe address** must be set as an **Allocator** on the vault
- Deployed vault and adapter addresses from the deployment script

## Setup

1. Install dependencies:
   ```bash
   cd usds-flagship
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

3. Required environment variables:

   **From your setup:**
   - `RPC_URL` - Ethereum RPC endpoint
   - `PRIVATE_KEY` - Bot signer's private key (one of the 3 Safe owners)
   - `SAFE_ADDRESS` - Safe 1/3 multisig address (set as allocator on the vault)

   **From DeployFlagshipVaultV2 output:**
   - `VAULT_ADDRESS` - Flagship Vault V2 address
   - `ADAPTER_ADDRESS` - MorphoMarketV1AdapterV2 address
   - `ORACLE_CBBTC` - cbBTC/USDS oracle address
   - `ORACLE_WSTETH` - wstETH/USDS oracle address
   - `ORACLE_WETH` - WETH/USDS oracle address

   **Pre-configured (existing deployment):**
   - `ORACLE_STUSDS` - Already defaults to `0x0A976226d113B67Bd42D672Ac9f83f92B44b454C`

   **Optional (correct defaults provided):**
   - `LLTV_*` - All default to 86% (860000000000000000) per BA Labs recommendation
   - `DRY_RUN` - Set to `true` for simulation mode

## Usage

### Manual Run

```bash
# Development (uses tsx)
npm run dev

# Production (compile first)
npm run build
npm start
```

### Dry Run Mode

Set `DRY_RUN=true` in `.env` to simulate without executing transactions:
```bash
DRY_RUN=true npm run dev
```

### Cronjob Setup

Run every 6 hours to maintain allocation:
```bash
# Edit crontab
crontab -e

# Add this line (adjust paths as needed)
0 */6 * * * cd /path/to/morpho-allocator-bots/usds-flagship && /usr/bin/npm run allocate >> /var/log/vault-allocator.log 2>&1
```

## How It Works

1. **Verify Safe setup** — Confirms bot is a Safe owner and threshold is 1
2. **Check permissions** — Verifies the Safe is an allocator on the vault
3. **Read current state** — Gets total assets, adapter total, idle balance
4. **Read per-market balances** — Calls `adapter.expectedSupplyAssets(marketId)` for each market
5. **Compute per-market actions** — Only allocate/deallocate markets that are off-target. Skips (no transaction) only when *every* market's deviation from its own target is below the threshold — so asymmetric migrations still fire even when the aggregate allocated total already matches target
6. **Check market liquidity** — For deallocations, reads Morpho Blue market state and caps amounts to available liquidity (minus a 5% reserve — except WETH/USDS, which is capped to a 93% max-utilization target instead)
7. **Execute via Safe** — Signs and executes through the Safe multisig with a 50% gas buffer
8. **Log results** — Reports final state

## Allocation Logic

The core allocation logic lives in `src/allocation-logic.ts` and is tested independently in `src/allocation-logic.test.ts`. It handles these cases:

### Case 1: Fresh vault (zero allocations)
All markets at 0%. The bot allocates 5% of totalAssets to each market.
```
Before: [0%, 0%, 0%, 0%]  → Actions: allocate 5% to each
After:  [5%, 5%, 5%, 5%]  (20% total)
```

### Case 2: Partial allocation (some markets funded, some not)
Happens when some transactions succeed and others fail (e.g., gas issues). The bot reads actual per-market balances and **only** allocates to under-funded markets — it does NOT blindly divide the total deficit by 4.
```
Before: [5%, 0%, 5%, 0%]  → Actions: allocate 5% to markets 1 and 3 only
After:  [5%, 5%, 5%, 5%]  (20% total)
```

### Case 3: All markets at target
Every market's deviation from its own target is below the 0.1% threshold. No actions taken.
```
Before: [5%, 5%, 5%, 5%]  → No actions
```

### Case 4: Over-allocated
Can happen after large withdrawals shrink totalAssets. The bot deallocates the excess per market.
```
Before: [7.5%, 7.5%, 7.5%, 7.5%]  → Actions: deallocate 2.5% from each
After:  [5%, 5%, 5%, 5%]           (20% total)
```

**Liquidity-constrained deallocations:** If a Morpho Blue market has high utilization, the bot may not be able to withdraw the full desired amount. In that case, the deallocate is capped to available liquidity minus a 5% reserve (to avoid pushing utilization to 100%), or skipped entirely if the market is at ≥95% utilization. **A market with an explicit max-utilization target (currently WETH/USDS at 93%, via `maxUtilizationBps`) uses that instead of the flat reserve: the withdrawal is capped so post-withdraw utilization stays ≤ 93%, and skipped (waiting for borrowers to repay) once already at/above it.** This can leave the vault temporarily imbalanced and the overall allocation above the 20% target. The bot self-heals over subsequent runs as market liquidity improves.

### Case 5: Mixed (some over, some under)
Some markets are above target, others below. The bot issues both allocate and deallocate actions in a single run.
```
Before: [8%, 1%, 8%, 1%]  → Actions: deallocate 3% from 0,2; allocate 4% to 1,3
After:  [5%, 5%, 5%, 5%]  (20% total)
```

### Case 6: Interest accrual
Markets accrue interest over time, causing small deviations. As long as every market's deviation from its target stays below 0.1%, no rebalancing is triggered.

### Case 7: Dust sweep of a retired market
A market with target 0 that still holds a residual is swept back to the vault even when that residual is below the 0.1% rebalance threshold — as long as it's at least `minAllocationAmount`. This keeps a retired market from getting stuck holding up to ~0.1% of totalAssets that the normal threshold would otherwise ignore.
```
Targets: [0%, 10%, 10%, 0%]
Before:  [0.05%, 10%, 10%, 0%]  (stUSDS holds 0.05% — under the 0.1% threshold but ≥ minAllocationAmount)
         → Action: deallocate stUSDS's residual to the vault
After:   [~0%, 10%, 10%, 0%]    (drained to < minAllocationAmount dust)
```

### Fresh state reads + headroom (1 bps)
The vault's relative cap check uses `mulDivDown(totalAssets, relativeCap, WAD)` to compute the maximum allowed allocation. Interest accrues between the bot's RPC read and tx execution, which can cause the adapter's `expectedSupplyAssets` to overshoot the cap.

The 80% idle portion doesn't earn interest, so `totalAssets` grows slower than any individual market's `expectedSupplyAssets`. This means even with fresh reads, interest accrual over a few blocks can cause `RelativeCapExceeded`.

To prevent this, the bot:
1. Re-reads `vault.totalAssets()` and `adapter.expectedSupplyAssets(marketId)` fresh right before each allocation
2. Subtracts a 1 bps (0.01%) headroom from the cap limit

```
capLimit     = totalAssets * relativeCap / WAD   // replicates vault's mulDivDown
headroom     = capLimit * 1 / 10000              // 1 bps of cap limit
effectiveCap = capLimit - headroom
amount       = effectiveCap - expectedSupplyAssets
```

The headroom covers ~10 minutes of delay at 200% APR max rate. On a $20M vault (5% cap = $1M per market), the headroom is $100 per market — negligible for the strategy. Deallocations don't need this treatment since they have no cap check.

## Testing

```bash
npm test
```

Runs unit tests for the allocation logic covering all cases above, including the real-world "1 USDS dead deposit" scenario.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `targetIdlePercent` | 80% | Target idle percentage |
| `targetAllocatedPercent` | 20% | Total allocated target (must equal the sum of per-market targets) |
| `TARGET_<MARKET>_BPS` | 500 (5%) | Per-market target in basis points (env-overridable, see Strategy) |
| `rebalanceThresholdBps` | 0.1% | Min per-market deviation to trigger rebalance |
| `minAllocationAmount` | 100 USDS | Min per-action amount to allocate/deallocate (suppresses dust transactions) |
| `MAX_DEALLOCATE_USDS` | 0 (no cap) | Optional per-market cap on deallocation per cycle, for a gentler migration |

### Aggregate adapter cap

Each allocation is bounded not just by its own market's relative cap but by the vault's
**aggregate adapter cap** (20%). Because allocations are funded from the vault's idle
balance — not from that cycle's deallocations — the bot must keep the *sum* of allocations
within the room left under the 20% cap after deallocations; otherwise the whole atomic
batch reverts with `RelativeCapExceeded`. This matters mid-migration: when the retiring
markets can only be partially drained (pool liquidity), the bot scales its allocations down
to fit the cap and grows the destination markets over successive cycles instead of
overshooting in one shot.

## Dead deposits

All five markets are secured against ERC-4626 inflation attacks by a supply held on behalf of
`0x000000000000000000000000000000000000dEaD`
([Morpho docs](https://docs.morpho.org/curate/tutorials-market-v1/dead-deposit/)):

| Market | dEaD supply shares | Note |
| --- | --- | --- |
| stUSDS/USDS | 1e24 | 1 USDS, seeded at deployment |
| cbBTC/USDS | 1e24 | 1 USDS, seeded at deployment |
| wstETH/USDS | 1e24 | 1 USDS, seeded at deployment |
| WETH/USDS | 1e24 | 1 USDS, seeded at deployment |
| PT-sUSDS/USDS | 1e9 | seeded 2026-07-28, [tx](https://etherscan.io/tx/0x18ded5af565264456a70fcde243f77d37bb6ccc5d8e1241723c7d04c2797d0a7) |

The four original markets used the older "1 whole USDS" convention (1 USDS mints ≈1e24 shares).
The documented threshold is a fixed **1e9 shares** — Morpho markets use a constant
`VIRTUAL_SHARES = 1e6`, so it does not scale with the loan token's decimals — which is what
PT-sUSDS/USDS was seeded with, for 1001 wei USDS. The extra 1e15× on the older four buys no
additional protection.

When adding a market, dead-deposit it before the vault allocates into it. Any EOA can do this —
no allocator or curator role is needed — and it should specify `shares`, not `assets`, so Morpho
computes the asset cost itself rather than the caller guessing at a share price that moves with
interest:

```bash
MORPHO=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
cast send $LOAN_TOKEN 'approve(address,uint256)' $MORPHO <a bit over the cost>
cast send $MORPHO 'supply((address,address,address,address,uint256),uint256,uint256,address,bytes)' \
  '(<loanToken>,<collateral>,<oracle>,<irm>,<lltv>)' \
  0 1000000000 0x000000000000000000000000000000000000dEaD 0x
# verify: first return value should be >= 1e9
cast call $MORPHO 'position(bytes32,address)(uint256,uint128,uint128)' \
  <marketId> 0x000000000000000000000000000000000000dEaD
```

The `1 USDS dead deposit` case in `src/allocation-logic.test.ts` covers the allocation logic
against a vault whose entire balance is a dead deposit.

## Security Notes

- **Never commit `.env`** - Contains private key
- **Safe multisig** - Even though the bot can execute with threshold=1, the 1/3 setup allows 2 other signers to intervene or replace the bot signer if compromised
- **Bot's EOA only pays gas** - The bot's EOA doesn't hold any vault permissions directly; only the Safe does
- **Monitor the bot** - Check logs regularly
- **Test with DRY_RUN first** - Verify logic before live execution

## Extending for Dynamic Weights

To implement price-based dynamic allocation:

1. Add Chainlink price feed reads
2. Calculate weights based on price/volatility
3. Set each market's `targetBps` from those weights
4. Ensure the per-market targets still sum to the 20% allocated cap

Example modification point in `allocator.ts`:
```typescript
// Replace fixed per-market targetBps with dynamic calculation
const weights = await calculateDynamicWeights(publicClient);
for (const market of markets) {
  market.targetBps = weights[market.name]; // basis points; must sum to targetAllocatedPercent
}
```

## Troubleshooting

### "Safe is not an allocator"
The Safe multisig address (not the bot's EOA) must be set as allocator by the curator:
```solidity
vault.submit(abi.encodeWithSelector(IVaultV2.setIsAllocator.selector, safeAddress, true));
vault.setIsAllocator(safeAddress, true);
```

### "Bot signer is not an owner of Safe"
The bot's EOA must be one of the 3 owners on the Safe multisig.

### "Safe threshold is N, expected 1"
The Safe must have a threshold of 1 so the bot can execute autonomously.

### GS013 revert (Safe inner call failure)
The Safe reverts with GS013 when the inner call fails and `safeTxGas`/`gasPrice` are both 0 (our case). Common causes:
- **Insufficient market liquidity** — The bot tried to deallocate (withdraw) more than the idle liquidity available in a Morpho Blue market. This happens when markets have high utilization (borrows ≈ supply). The bot now reads each market's `totalSupplyAssets` and `totalBorrowAssets` from Morpho Blue before deallocating, and caps the withdrawal amount to `availableLiquidity - 5% reserve` (or, for markets with an explicit max-utilization target such as WETH/USDS at 93%, to that utilization ceiling). Markets at/above the ceiling (≥95% under the reserve model, ≥93% for WETH) are skipped entirely. The bot retries on the next run as liquidity improves.
- **Per-market cap exceeded** — The bot tried to allocate beyond 5% to a market that was already at target. Fixed by reading per-market balances instead of assuming equal distribution.
- **Out of gas** — Gas estimation was too tight due to state changes between estimation and execution. Fixed by adding a 50% gas buffer on `estimateContractGas`.
- **Insufficient idle balance** — Not enough USDS in the vault to allocate.

### "Allocation exceeds cap"
The vault has 5% relative cap per market and 20% total. If you're hitting this:
- Check existing per-market allocations (the bot logs these)
- Reduce allocation amount
- Or increase caps via curator (timelocked)

### Transaction reverts
Common causes:
- Oracle address incorrect
- Market doesn't exist (needs to be created first)
