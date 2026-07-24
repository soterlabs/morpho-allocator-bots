# Morpho Allocator Bots

Allocator bots for **Morpho Vault V2** vaults on Ethereum mainnet. Each bot keeps its
target vault on a defined idle/allocated strategy by allocating and deallocating across
that vault's Morpho Blue markets, executing on-chain through a **Safe multisig** that
holds the vault's `Allocator` role.

## Repository structure

Each targeted vault gets its **own top-level folder** containing a self-contained
Node/TypeScript bot (its own `package.json`, `src/`, tests, and Railway config):

```
morpho-allocator-bots/
├── usds-flagship/          # bot for the Flagship USDS Vault V2
│   ├── src/
│   ├── package.json
│   ├── railway.toml        # Railway build/start/cron for this bot
│   ├── nixpacks.toml
│   ├── .env.example
│   └── README.md           # bot-specific setup & strategy details
├── usdt-savings/           # bot for the sky.money USDT Savings Vault V2
│   └── ...                 # same layout
└── README.md               # (this file) overview + targeted vaults
```

To add a bot for another vault, create a new sibling folder with the same layout.

## Deployment (Railway)

Each bot is deployed as its **own Railway service** from this single repository:

- The service's **Root Directory** is set to the bot's folder (e.g. `usds-flagship`), so
  Railway builds from that folder and reads its `railway.toml` / `nixpacks.toml`.
- Build/start/cron come from that folder's `railway.toml` (`npm install && npm run build`
  → `npm start`, on a cron schedule).
- Secrets and per-market config are set as **environment variables on the service**
  (never committed — see each bot's `.env.example`). The signing key is a **sealed**
  Railway variable.

## Targeted vaults

### 1. Flagship USDS Vault V2 — `usds-flagship/`

Maintains an **80% idle / 20% allocated** strategy across five USDS-denominated Morpho
Blue markets. Per-market targets are configurable (basis points) and their sum must equal
the 20% allocated target. See [`usds-flagship/README.md`](usds-flagship/README.md) for the
full strategy and setup.

| Role | Address |
| --- | --- |
| Vault (Morpho Vault V2) | [`0xE15fcC81118895b67b6647BBd393182dF44E11E0`](https://etherscan.io/address/0xE15fcC81118895b67b6647BBd393182dF44E11E0) |
| Vault adapter | [`0xf94BE39e8863183Ff41194b5923627C90A34039D`](https://etherscan.io/address/0xf94BE39e8863183Ff41194b5923627C90A34039D) |
| Allocator — Safe 1/3 multisig (holds the vault's `Allocator` role) | [`0xE4d5F54CE1830d5eCC49751021F306CFE7a52649`](https://etherscan.io/address/0xE4d5F54CE1830d5eCC49751021F306CFE7a52649) |
| Bot signer (EOA; owner of the Safe, signs & executes) | [`0xD4351069BbbB2F73A850100Ecb655e9fCA0b7829`](https://etherscan.io/address/0xD4351069BbbB2F73A850100Ecb655e9fCA0b7829) |
| Loan token — USDS | [`0xdC035D45d973E3EC169d2276DDab16f1e407384F`](https://etherscan.io/address/0xdC035D45d973E3EC169d2276DDab16f1e407384F) |
| Morpho Blue | [`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`](https://etherscan.io/address/0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb) |
| Adaptive Curve IRM | [`0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC`](https://etherscan.io/address/0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC) |

**Markets the bot allocates into** (all with USDS as the loan token):

| Market | Collateral | Oracle | LLTV | Current target |
| --- | --- | --- | --- | --- |
| stUSDS/USDS | [`0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9`](https://etherscan.io/address/0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9) | [`0x0A976226d113B67Bd42D672Ac9f83f92B44b454C`](https://etherscan.io/address/0x0A976226d113B67Bd42D672Ac9f83f92B44b454C) | 86% | 0% (retired) |
| cbBTC/USDS | [`0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`](https://etherscan.io/address/0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf) | [`0xA5AEb90F9f122989fE69Ae6224Ed923A0caF33B4`](https://etherscan.io/address/0xA5AEb90F9f122989fE69Ae6224Ed923A0caF33B4) | 86% | 6.67% |
| wstETH/USDS | [`0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`](https://etherscan.io/address/0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0) | [`0xc9A9440d1545047b2Ce3624DB425410cF2EAE292`](https://etherscan.io/address/0xc9A9440d1545047b2Ce3624DB425410cF2EAE292) | 86% | 6.67% |
| PT-sUSDS/USDS | [`0xdC169AbE56461A2E0c034Da431Ac2a3ebf596094`](https://etherscan.io/address/0xdC169AbE56461A2E0c034Da431Ac2a3ebf596094) | [`0xda5901EF31ecAFa6561B2e56B4997FAdd3dB4646`](https://etherscan.io/address/0xda5901EF31ecAFa6561B2e56B4997FAdd3dB4646) | 91.5% | 6.66% (5M cap) |
| WETH/USDS | [`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`](https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2) | [`0x76b2242ea5BE1FCBBF4206EA09601EA5aB22Af4d`](https://etherscan.io/address/0x76b2242ea5BE1FCBBF4206EA09601EA5aB22Af4d) | 86% | 0% (retired) |

> **Current targets**: stUSDS and WETH retired to 0%; cbBTC / wstETH / PT-sUSDS at ~6.66%
> each (667 / 667 / 666 = 2000). **PT-sUSDS/USDS** (91.5% LLTV, market id
> `0x9a8dab…f24f`) has a **5M USDS absolute cap** enforced off-chain by the bot; overflow
> above the cap is split equally between cbBTC and wstETH. **WETH/USDS** is drained only up to
> 93% market utilization. Targets are set per-service via `TARGET_<MARKET>_BPS` env vars;
> every market that is grown or drained must also have its `ORACLE_*` set.

### 2. sky.money USDT Savings Vault V2 — `usdt-savings/`

A **migration bot** (not an idle/allocated strategy): it moves the vault's liquidity from the
old sUSDS/USDT market (DAI/USD oracle) to the new sUSDS/USDT market (USDS/USD oracle, USDT/USD
capped at $1.00), draining the old market up to 93% utilization each cycle and waiting above
it. See [`usdt-savings/README.md`](usdt-savings/README.md). **USDT has 6 decimals.**

| Role | Address |
| --- | --- |
| Vault (Morpho Vault V2) | [`0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11`](https://etherscan.io/address/0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11) |
| Vault adapter | _set per-service (`ADAPTER_ADDRESS`)_ |
| Allocator — Safe (holds the vault's `Allocator` role; bot signs through it) | _set per-service (`SAFE_ADDRESS`)_ |
| Loan token — USDT (6 dp) | [`0xdAC17F958D2ee523a2206206994597C13D831ec7`](https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7) |
| Collateral — sUSDS | [`0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`](https://etherscan.io/address/0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD) |

| Market | Direction | Market ID | Oracle | LLTV |
| --- | --- | --- | --- | --- |
| Old sUSDS/USDT | drain from | `0x3274…cf0b` | `0x0C426d…4C79` (DAI/USD) | 96.5% |
| New sUSDS/USDT | allocate to | `0x26b1…4d96` | `0x1C7DBd…2F9C` (USDS/USD, capped USDT) | 96.5% |

> The Sky.money curator msig `0x3F32bC09d41eE699844F8296e806417D6bf61Bba` is the vault's
> owner/curator. The bot executes through a separate bot-controlled **Safe** (set as an
> allocator on the vault) via `SAFE_ADDRESS`.

---

> **Naming convention:** each folder is named after its vault (not necessarily a
> `-flagship` suffix) — e.g. `usds-flagship/`, `usdt-savings/` — and its Railway service
> is `<folder>-bot` (`usds-flagship-bot`, `usdt-savings-bot`).
