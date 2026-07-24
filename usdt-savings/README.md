# USDT Savings Vault Allocator Bot

Migration bot for the [**sky.money USDT Savings Vault V2**](https://app.morpho.org/ethereum/vault/0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11/skymoney-usdt-savings). It moves the vault's liquidity out of the **old** sUSDS/USDT market (DAI/USD oracle, uncapped USDT) and into the **new** sUSDS/USDT market (USDS/USD oracle, USDT/USD capped at $1.00). Both markets share the same collateral (sUSDS), loan token (USDT), IRM, and 96.5% LLTV — they differ only by oracle.

Transactions execute through a **Safe multisig** (threshold 1) that must be an allocator on the vault; the bot is one of the Safe's owners and signs autonomously.

> **USDT has 6 decimals.** All amounts in this bot are USDT (6 dp), unlike the 18-decimal `usds-flagship` bot.

## Strategy

Each run the bot:
1. Reads the vault's position in the **old** market and the old market's pool state (supply/borrow).
2. Computes how much to move this round: `min(old position, withdrawable-at-93%-utilization)`.
   - Deallocating from a Morpho market removes supply while borrows stay put, raising
     utilization. The bot caps the withdrawal so post-withdraw utilization stays **≤ 93%**
     (`MAX_UTILIZATION_BPS`).
   - If the old market is **already at/above 93%** utilization, it withdraws **nothing and
     waits** — rising rates on the old market incentivize borrowers to repay, freeing
     liquidity over the following cycles.
3. In a single atomic Safe transaction: `deallocate(amount)` from the old market, then
   `allocate(amount)` to the new market.
4. Once the old market position falls below the `MIN_MIGRATE_USDT` dust floor, the migration
   is **complete** and each run is a no-op.

The fund-affecting decision (`computeMigration`) is a pure function in `src/migration-logic.ts`, unit-tested in `src/migration-logic.test.ts` (utilization cap, wait/dust/done boundaries).

## Markets

| | Market ID | Oracle |
| --- | --- | --- |
| **Old** (drain) | `0x3274643db77a064abd3bc851de77556a4ad2e2f502f4f0c80845fa8f909ecf0b` | `0x0C426d174FC88B7A25d59945Ab2F7274Bf7B4C79` (DAI/USD) |
| **New** (fill) | `0x26b178d49895f80ca3c39b2745efc4cd9adcddfcc73dae93e531e86977ec4d96` | `0x1C7DBd66dF93594bA08af8e72c75Ba2004d92F9C` (USDS/USD, capped USDT) |

Common params: loan token USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`, collateral sUSDS `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`, IRM `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC`, LLTV 96.5%. The bot re-derives both market ids from these params at startup and **fails fast** if they don't match the ids above (guards against a wrong oracle/LLTV silently addressing the wrong market).

## Prerequisites

- Node.js >= 18.0.0
- The new market's caps must be live on the vault and the liquidity adapter switched to it
  (migration steps 1–3 in the deployment repo) before reallocation makes sense.
- A **Safe** (threshold 1) set as an **allocator** on the vault, with the bot's signer as an owner.

## Setup

```bash
cd usdt-savings
npm install
cp .env.example .env      # fill in PRIVATE_KEY, SAFE_ADDRESS, ADAPTER_ADDRESS
DRY_RUN=true npm run dev   # simulate — prints the planned round without executing
npm run dev                # execute for real
```

Required env vars: see [`.env.example`](.env.example). `VAULT_ADDRESS` defaults to the live USDT Savings vault; `ADAPTER_ADDRESS` must be set to the vault's `MorphoMarketV1AdapterV2`.

## Deployment

Runs as its own Railway service on a cron schedule (`railway.toml`, every 6h). See the
repository root [README](../README.md) for the per-vault Railway model. Because a migration
round only fires when the old market has withdrawable liquidity, running every few hours lets
the bot chip away as borrowers repay, and quietly no-ops once the old market is drained.

## Tests

```bash
npm test
```
