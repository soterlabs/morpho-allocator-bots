/**
 * Shared market configuration for the usds-flagship bots.
 *
 * Single source of truth for the market table, Morpho addresses, the id/cap
 * derivation helpers and the bands-mode market-table validation, used by
 * allocator.ts (writes), optimize.ts (read-only) and fork-sim.ts.
 */
import { encodeFunctionData, encodeAbiParameters, keccak256, parseEther, type Address, type Hex } from 'viem';
import { parseTargetBps } from './allocation-logic.js';
import type { MarketMode } from './band-config.js';

export const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F' as Address;
export const IRM_ADAPTIVE = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC' as Address;
export const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;
// sUSDS (Sky Savings USDS). ssr() returns the per-second savings rate in RAY (1e27);
// APY = (ssr/1e27)^31536000 - 1. Read on-chain by the bands-mode allocator as the
// steering anchor (see band-config.ts computeSsrApy).
export const SUSDS = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD' as Address;

// Minimal sUSDS ABI fragment: the ssr() view (per-second rate, RAY-scaled uint256).
export const susdsAbi = [
  {
    name: 'ssr',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

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
  // the bot (not a market/vault param). bps mode: when the bps target exceeds this, the
  // market is held at the cap and the overflow is redistributed to overflowReceiver markets.
  // bands mode: the market's cap unless CAP_<MARKET>_USDS overrides it. Used by
  // PT-sUSDS/USDS (5M cap).
  absoluteCap?: bigint;
  // Optional bands-mode caps from CAP_<MARKET>_USDS (whole USDS) and CAP_<MARKET>_BPS
  // (share of totalAssets) — off-chain mirrors of the vault's caps, same semantics as the
  // bps mode's absoluteCap: the bot never reads the on-chain absolute cap, and a breach of
  // these (not of the on-chain relative cap) is what triggers a priority withdrawal. A
  // market with neither is bounded only by the on-chain relative cap at allocate time and
  // never emits a priority withdrawal. 0 means "hold nothing" — drained down to the dust floor.
  capUsds?: bigint;
  capBps?: number;
  // When true, this market absorbs an equal share of overflow from absolute-capped markets on
  // top of its own bps target. Set on cbBTC/USDS and wstETH/USDS to soak up PT-sUSDS overflow.
  overflowReceiver?: boolean;
  // Optional max utilization (bps) for deallocations from this market. When set, withdrawals
  // are capped so post-withdraw utilization stays <= this (and skipped/waited once already
  // at/above it) instead of the flat supply-reserve cushion. Set on WETH/USDS (9300 = 93%).
  // Used by the bps mode only — bands mode derives the per-cycle utilization hold from the
  // band decision instead.
  maxUtilizationBps?: number;
  // Bands-mode role of this market (ALLOCATION_MODE=bands; bps mode rejects PRIMARY):
  //   STEERED  — utilization-band rate steering toward the SSR floor
  //   PRIMARY  — always asks for deposits up to its cap, served first (at most one)
  //   SOUNDING — reserved; configuring it refuses to start (parseMarketMode throws)
  //   RETIRED  — the bot never touches the market
  // From MODE_* env vars, validated against the enum (parseMarketMode throws on anything else).
  mode: MarketMode;
  // Optional per-market SSR_t margin override (bps) for bands mode, from SSR_T_MARGIN_<MARKET>_BPS
  // env vars. Unset = the market uses the global SSR_T_MARGIN_BPS. Lets PT-sUSDS and the
  // bluechips carry different rate hurdles.
  ssrTMarginBps?: number;
  encodedParams?: Hex;
}

// The bands-mode market roles. Kept as a value list (not just the MarketMode type) so env
// input can be validated against it at startup.
const MARKET_MODES: readonly MarketMode[] = ['STEERED', 'PRIMARY', 'SOUNDING', 'RETIRED'];

/**
 * Parse a bands-mode market mode from a raw MODE_* env value.
 *
 * Returns `defaultMode` ONLY when the value is unset (undefined). Any present value must
 * be exactly one of the MarketMode enum members (after trimming) — anything else throws,
 * following the fail-loud posture of parseTargetBps: a typo'd mode must never silently
 * fall back to a default that steers real funds differently than intended.
 *
 * SOUNDING is a recognized name with no implementation behind it, so configuring it
 * also throws — the bot must refuse to start rather than run a market on a strategy
 * that does not exist.
 */
export function parseMarketMode(raw: string | undefined, defaultMode: MarketMode, label: string): MarketMode {
  if (raw === undefined) return defaultMode;
  const trimmed = raw.trim() as MarketMode;
  if (!MARKET_MODES.includes(trimmed)) {
    throw new Error(`${label} must be one of ${MARKET_MODES.join(', ')}, got "${raw}"`);
  }
  if (trimmed === 'SOUNDING') {
    throw new Error(`${label}=SOUNDING is not implemented — use STEERED, PRIMARY or RETIRED`);
  }
  return trimmed;
}

/**
 * Parse an optional per-market bps env (SSR_T_MARGIN_<MARKET>_BPS, CAP_<MARKET>_BPS).
 * Unset -> undefined, which each consumer resolves its own way (global margin fallback;
 * no share cap). Present values get the same strict whole-number [0, 10000] validation
 * as every other bps env (parseTargetBps); 0 is valid.
 */
function parseOptionalBps(raw: string | undefined, label: string): number | undefined {
  return raw === undefined ? undefined : parseTargetBps(raw, 0, label);
}

/**
 * Parse an optional bands-mode cap amount (whole USDS -> 18-dec). Unset -> undefined;
 * any present value must be a canonical non-negative whole number (0 allowed).
 */
function parseOptionalCapUsds(raw: string | undefined, label: string): bigint | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number of USDS (18-dec conversion is internal), got "${raw}"`);
  }
  return parseEther(trimmed);
}

/**
 * Bands-mode cap of a market in USDS on the given totalAssets snapshot: the smaller of
 * the amount cap (CAP_<MARKET>_USDS, else the bps-mode absoluteCap) and the share cap
 * (CAP_<MARKET>_BPS x totalAssets), over whichever of the two is configured.
 * Undefined when the market has neither — it is then bounded only by the on-chain
 * relative cap, exactly as in bps mode.
 */
export function computeMarketCap(market: MarketConfig, totalAssets: bigint): bigint | undefined {
  const capUsds = market.capUsds ?? market.absoluteCap;
  const fromShare = market.capBps === undefined ? undefined : (totalAssets * BigInt(market.capBps)) / 10000n;
  if (capUsds === undefined) return fromShare;
  if (fromShare === undefined) return capUsds;
  return fromShare < capUsds ? fromShare : capUsds;
}

/**
 * Startup validation of the market table for bands mode: at most one market may be
 * PRIMARY — the priority carve is defined for one market. Throws (refuses to start)
 * otherwise.
 */
export function validateBandsMarkets(marketTable: readonly MarketConfig[]): void {
  const primaries = marketTable.filter(m => m.mode === 'PRIMARY');
  if (primaries.length > 1) {
    throw new Error(
      `${primaries.map(m => m.name).join(', ')} are all PRIMARY — at most one market may be PRIMARY`
    );
  }
}

/**
 * Startup validation of the market table for bps mode: PRIMARY has no meaning there,
 * so a market configured as PRIMARY is a misdirected bands-mode config — refuse to start
 * rather than silently steer it by static bps.
 */
export function validateBpsMarkets(marketTable: readonly MarketConfig[]): void {
  const primaries = marketTable.filter(m => m.mode === 'PRIMARY');
  if (primaries.length > 0) {
    throw new Error(
      `${primaries.map(m => m.name).join(', ')} are PRIMARY, which only exists in bands mode — ` +
      `set ALLOCATION_MODE=bands or MODE_<MARKET>=STEERED`
    );
  }
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
    mode: parseMarketMode(process.env.MODE_STUSDS, 'RETIRED', 'MODE_STUSDS'),
    ssrTMarginBps: parseOptionalBps(process.env.SSR_T_MARGIN_STUSDS_BPS, 'SSR_T_MARGIN_STUSDS_BPS'),
    capUsds: parseOptionalCapUsds(process.env.CAP_STUSDS_USDS, 'CAP_STUSDS_USDS'),
    capBps: parseOptionalBps(process.env.CAP_STUSDS_BPS, 'CAP_STUSDS_BPS'),
  },
  {
    name: 'cbBTC/USDS',
    collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address,
    oracle: (process.env.ORACLE_CBBTC || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_CBBTC || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_CBBTC_BPS, 667, 'TARGET_CBBTC_BPS'),
    overflowReceiver: true,
    mode: parseMarketMode(process.env.MODE_CBBTC, 'STEERED', 'MODE_CBBTC'),
    ssrTMarginBps: parseOptionalBps(process.env.SSR_T_MARGIN_CBBTC_BPS, 'SSR_T_MARGIN_CBBTC_BPS'),
    capUsds: parseOptionalCapUsds(process.env.CAP_CBBTC_USDS, 'CAP_CBBTC_USDS'),
    capBps: parseOptionalBps(process.env.CAP_CBBTC_BPS, 'CAP_CBBTC_BPS'),
  },
  {
    name: 'wstETH/USDS',
    collateral: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address,
    oracle: (process.env.ORACLE_WSTETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WSTETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WSTETH_BPS, 667, 'TARGET_WSTETH_BPS'),
    overflowReceiver: true,
    mode: parseMarketMode(process.env.MODE_WSTETH, 'STEERED', 'MODE_WSTETH'),
    ssrTMarginBps: parseOptionalBps(process.env.SSR_T_MARGIN_WSTETH_BPS, 'SSR_T_MARGIN_WSTETH_BPS'),
    capUsds: parseOptionalCapUsds(process.env.CAP_WSTETH_USDS, 'CAP_WSTETH_USDS'),
    capBps: parseOptionalBps(process.env.CAP_WSTETH_BPS, 'CAP_WSTETH_BPS'),
  },
  {
    name: 'PT-sUSDS/USDS',
    collateral: '0xdC169AbE56461A2E0c034Da431Ac2a3ebf596094' as Address,
    oracle: (process.env.ORACLE_PTSUSDS || PT_SUSDS_ORACLE) as Address,
    lltv: BigInt(process.env.LLTV_PTSUSDS || LLTV_91_5_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_PTSUSDS_BPS, 666, 'TARGET_PTSUSDS_BPS'),
    absoluteCap: PT_SUSDS_ABSOLUTE_CAP,
    mode: parseMarketMode(process.env.MODE_PTSUSDS, 'STEERED', 'MODE_PTSUSDS'),
    ssrTMarginBps: parseOptionalBps(process.env.SSR_T_MARGIN_PTSUSDS_BPS, 'SSR_T_MARGIN_PTSUSDS_BPS'),
    capUsds: parseOptionalCapUsds(process.env.CAP_PTSUSDS_USDS, 'CAP_PTSUSDS_USDS'),
    capBps: parseOptionalBps(process.env.CAP_PTSUSDS_BPS, 'CAP_PTSUSDS_BPS'),
  },
  {
    name: 'WETH/USDS',
    collateral: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    oracle: (process.env.ORACLE_WETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WETH_BPS, 0, 'TARGET_WETH_BPS'),
    maxUtilizationBps: WETH_MAX_UTILIZATION_BPS,
    mode: parseMarketMode(process.env.MODE_WETH, 'STEERED', 'MODE_WETH'),
    ssrTMarginBps: parseOptionalBps(process.env.SSR_T_MARGIN_WETH_BPS, 'SSR_T_MARGIN_WETH_BPS'),
    capUsds: parseOptionalCapUsds(process.env.CAP_WETH_USDS, 'CAP_WETH_USDS'),
    capBps: parseOptionalBps(process.env.CAP_WETH_BPS, 'CAP_WETH_BPS'),
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
