# USDT Savings Vault Allocator Bot

Migration bot for the [**sky.money USDT Savings Vault V2**](https://app.morpho.org/ethereum/vault/0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11/skymoney-usdt-savings). It moves the vault's liquidity out of the **old** sUSDS/USDT market (DAI/USD oracle, uncapped USDT) and into the **new** sUSDS/USDT market (USDS/USD oracle, USDT/USD capped at $1.00). Both markets share the same collateral (sUSDS), loan token (USDT), IRM, and 96.5% LLTV — they differ only by oracle.

Transactions execute through a **Safe multisig** (threshold 1) that must be an allocator on the vault; the bot is one of the Safe's owners and signs autonomously.

> **USDT has 6 decimals.** All amounts in this bot are USDT (6 dp), unlike the 18-decimal `usds-flagship` bot.

## Strategy

Each run the bot:
1. Reads the vault's position in the **old** market, the old market's pool state (supply/borrow),
   and the vault's **default liquidity route**.
2. Computes how much to move this round: `min(old position, withdrawable-at-93%-utilization)`.
   - Deallocating from a Morpho market removes supply while borrows stay put, raising
     utilization. The bot caps the withdrawal so post-withdraw utilization stays **≤ 93%**
     (`MAX_UTILIZATION_BPS`).
   - If the old market is **already at/above 93%** utilization, it withdraws **nothing and
     waits** — rising rates on the old market incentivize borrowers to repay, freeing
     liquidity over the following cycles.
3. In a single atomic Safe transaction: repoint the liquidity route (only when it isn't already
   on the new market), `deallocate(amount)` from the old market, then `allocate(amount)` to the
   new market.
4. Once the old market position falls below the `MIN_MIGRATE_USDT` dust floor, the migration
   is **complete** and each run is a no-op.

The fund-affecting decisions (`computeMigration`, `planLiquidityRoute`) are pure functions in
`src/migration-logic.ts`, unit-tested in `src/migration-logic.test.ts` (utilization cap,
wait/dust/done boundaries, route idempotence and the foreign-adapter guard).

## Default liquidity route

The vault stores a **liquidity adapter + liquidity data** pair (`liquidityAdapter()` /
`liquidityData()`). That pair is the vault's *default route*: a plain `deposit` forwards the
assets straight to that adapter with that data, and for a `MorphoMarketV1AdapterV2` the data is
`abi.encode(MarketParams)` — so it is what picks the market. While it still encodes the **old**
market, every new deposit into the vault lands back in the market the bot is draining (which is
what the Morpho UI shows as the market liquidity flows to).

So each run the bot also ensures the route is `ADAPTER_ADDRESS` + the **new** market's params,
via `setLiquidityAdapterAndData` — an **allocator-gated** call, the same role the bot's Safe
already holds (verified on-chain: the call succeeds from the allocator Safe and reverts from an
unprivileged address). The check is:

- **idempotent** — once the route matches, later runs emit no call at all, so this costs one
  transaction, not one per cycle;
- **independent of the migration** — it is applied even on rounds that migrate nothing (waiting
  on utilization, dust, or already drained), and shares the same atomic batch when both apply;
- **narrow** — the bot's mandate is *get the route off the old market*, not *own the route*. It
  only takes over a route that is unset or still points at the old market. A route aimed at
  another adapter contract, or at a third market, is someone else's decision: the bot logs a
  warning and leaves it alone rather than overwriting it on every run forever.
  `MANAGE_LIQUIDITY_ADAPTER=false` opts out entirely.

Because the vault does **not** validate the address passed to `setLiquidityAdapterAndData` — it
accepts any address, including an EOA or the zero address — the bot asserts at startup that
`ADAPTER_ADDRESS` is a registered adapter on the vault (`isAdapter`) and refuses to run otherwise.
Without that, a mistyped `ADAPTER_ADDRESS` could be written into the vault's route and break every
subsequent deposit, and the pre-flight simulation would not catch it (the call succeeds).

### Trade-off: the route is also the exit

The route is the first place *withdrawals* pull from too, and Vault V2 has one route pair for both
directions — you cannot send deposits to one market and redemptions to another. So while the
migration runs, redemption capacity is bounded by whichever market the route points at. Measured
on 2026-07-30, with the vault holding no idle:

| | available liquidity | utilization | max single redemption |
| --- | --- | --- | --- |
| Old market | 5.25M USDT | 90.03% | ~5,248,501 USDT |
| New market | 0.33M USDT | 98.65% | ~332,314 USDT |

The new market is thin because the vault is effectively its sole supplier and borrowers have been
absorbing each round's supply (utilization has sat near 99%), whereas the old market carries
~14.8M of third-party supply. Redemptions above the route market's liquidity are not stuck —
users can `forceDeallocate` from the other market for a **0.2%** penalty — but they are degraded.

This is the accepted cost of not growing the deprecated market: pointing the route at the new
market stops fresh deposits landing in the market being retired, and lowers the new market's
utilization (and so its borrow rate), which is what pulls borrowers across and frees the old
market's liquidity for the bot to withdraw. The condition resolves as the migration completes.

## Markets

| | Market ID | Oracle | Dead deposit |
| --- | --- | --- | --- |
| **Old** (drain) | `0x3274643db77a064abd3bc851de77556a4ad2e2f502f4f0c80845fa8f909ecf0b` | `0x0C426d174FC88B7A25d59945Ab2F7274Bf7B4C79` (DAI/USD) | 1e9 shares (pre-existing) |
| **New** (fill) | `0x26b178d49895f80ca3c39b2745efc4cd9adcddfcc73dae93e531e86977ec4d96` | `0x1C7DBd66dF93594bA08af8e72c75Ba2004d92F9C` (USDS/USD, capped USDT) | 1e9 shares ([tx](https://etherscan.io/tx/0x74f96720d79493b37ec0d7d99544c9d3aae2b6d5369cb037f7124c23b49d3569)) |

### Dead deposits

Both markets are secured against ERC-4626 inflation attacks by a supply held on behalf of
`0x000000000000000000000000000000000000dEaD`
([Morpho docs](https://docs.morpho.org/curate/tutorials-market-v1/dead-deposit/)). This matters
here specifically because a migration empties a market: the vault's adapter is the **sole
supplier** of both markets, so without the dead deposit the old market's share supply would
return to 0 once drained, which is exactly the state the attack needs.

The new market was seeded on 2026-07-28 — `supply(marketParams, assets: 0, shares: 1e9,
onBehalf: 0x…dEaD)`, which cost **1001 wei USDT (0.001001 USDT)**. Always specify `shares`
(not `assets`): the threshold is a fixed 1e9 *shares* because Morpho markets use a constant
`VIRTUAL_SHARES = 1e6` regardless of the loan token's decimals, and letting Morpho compute the
asset cost avoids guessing at a share price that moves with interest.

Common params: loan token USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`, collateral sUSDS `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`, IRM `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC`, LLTV 96.5%. The bot re-derives both market ids from these params at startup and **fails fast** if they don't match the ids above (guards against a wrong oracle/LLTV silently addressing the wrong market).

## Prerequisites

- Node.js >= 18.0.0
- The new market's caps must be live on the vault before reallocation makes sense (the bot
  switches the liquidity adapter to the new market itself — see above).
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
