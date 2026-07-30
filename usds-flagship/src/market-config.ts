/**
 * Shared market configuration for the usds-flagship bots.
 *
 * Single source of truth for the market table, Morpho addresses, and the
 * id/cap derivation helpers, used by both allocator.ts (writes) and
 * optimize.ts (read-only). Moved verbatim from allocator.ts.
 */
import { encodeFunctionData, encodeAbiParameters, keccak256, parseEther, type Address, type Hex } from 'viem';
import { parseTargetBps } from './allocation-logic.js';
import type { MarketMode } from './band-config.js';

// Constants
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
  // Used by the bps mode only — bands mode derives the per-cycle utilization hold from the
  // band decision instead.
  maxUtilizationBps?: number;
  // Bands-mode role of this market (ALLOCATION_MODE=bands; ignored in bps mode):
  //   STEERED  — utilization-band rate steering toward the SSR floor
  //   SOUNDING — demand sounding: feed tranches while utilization sticks high, never drain
  //   RETIRED  — drain to zero
  // From MODE_* env vars, validated against the enum (parseMarketMode throws on anything else).
  mode: MarketMode;
  // Optional per-market SSR_t margin override (bps) for bands mode, from SSR_T_MARGIN_<MARKET>_BPS
  // env vars. Unset = the market uses the global SSR_T_MARGIN_BPS. Lets PT-sUSDS and the
  // bluechips carry different harvest hurdles (Kacper: "docelowy rate powinien byc rozny
  // dla PT-sUSDS i bluechipow").
  ssrTMarginBps?: number;
  // Optional PT maturity (unix seconds, UTC). Bands mode blocks grows from T-30d and drains
  // the market like RETIRED from T-14d. Hardcoded per market — deliberately NOT env-tunable,
  // a maturity is a property of the collateral, not an operator knob.
  maturityUtcSec?: number;
  encodedParams?: Hex;
}

// The bands-mode market roles. Kept as a value list (not just the MarketMode type) so env
// input can be validated against it at startup.
const MARKET_MODES: readonly MarketMode[] = ['STEERED', 'SOUNDING', 'RETIRED'];

/**
 * Parse a bands-mode market mode from a raw MODE_* env value.
 *
 * Returns `defaultMode` ONLY when the value is unset (undefined). Any present value must
 * be exactly one of the MarketMode enum members (after trimming) — anything else throws,
 * following the fail-loud posture of parseTargetBps: a typo'd mode must never silently
 * fall back to a default that steers real funds differently than intended.
 */
export function parseMarketMode(raw: string | undefined, defaultMode: MarketMode, label: string): MarketMode {
  if (raw === undefined) return defaultMode;
  const trimmed = raw.trim() as MarketMode;
  if (!MARKET_MODES.includes(trimmed)) {
    throw new Error(`${label} must be one of ${MARKET_MODES.join(', ')}, got "${raw}"`);
  }
  return trimmed;
}

/**
 * Parse an optional per-market SSR_t margin override (bps). Unset -> undefined (the market
 * falls back to the global SSR_T_MARGIN_BPS from band-config). Present values get the same
 * strict whole-number [0, 10000] validation as every other bps env (parseTargetBps).
 */
function parseOptionalMarginBps(raw: string | undefined, label: string): number | undefined {
  return raw === undefined ? undefined : parseTargetBps(raw, 0, label);
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

// PT-sUSDS 26 Nov 2026 maturity: 2026-11-26T00:00:00Z. Bands mode blocks grows from T-30d
// and drains the market like RETIRED from T-14d (see band-controller.ts winddown overlay).
const PT_SUSDS_MATURITY_UTC_SEC = 1795651200;

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
    ssrTMarginBps: parseOptionalMarginBps(process.env.SSR_T_MARGIN_STUSDS_BPS, 'SSR_T_MARGIN_STUSDS_BPS'),
  },
  {
    name: 'cbBTC/USDS',
    collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address,
    oracle: (process.env.ORACLE_CBBTC || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_CBBTC || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_CBBTC_BPS, 667, 'TARGET_CBBTC_BPS'),
    overflowReceiver: true,
    mode: parseMarketMode(process.env.MODE_CBBTC, 'STEERED', 'MODE_CBBTC'),
    ssrTMarginBps: parseOptionalMarginBps(process.env.SSR_T_MARGIN_CBBTC_BPS, 'SSR_T_MARGIN_CBBTC_BPS'),
  },
  {
    name: 'wstETH/USDS',
    collateral: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address,
    oracle: (process.env.ORACLE_WSTETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WSTETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WSTETH_BPS, 667, 'TARGET_WSTETH_BPS'),
    overflowReceiver: true,
    mode: parseMarketMode(process.env.MODE_WSTETH, 'STEERED', 'MODE_WSTETH'),
    ssrTMarginBps: parseOptionalMarginBps(process.env.SSR_T_MARGIN_WSTETH_BPS, 'SSR_T_MARGIN_WSTETH_BPS'),
  },
  {
    name: 'PT-sUSDS/USDS',
    collateral: '0xdC169AbE56461A2E0c034Da431Ac2a3ebf596094' as Address,
    oracle: (process.env.ORACLE_PTSUSDS || PT_SUSDS_ORACLE) as Address,
    lltv: BigInt(process.env.LLTV_PTSUSDS || LLTV_91_5_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_PTSUSDS_BPS, 666, 'TARGET_PTSUSDS_BPS'),
    absoluteCap: PT_SUSDS_ABSOLUTE_CAP,
    mode: parseMarketMode(process.env.MODE_PTSUSDS, 'SOUNDING', 'MODE_PTSUSDS'),
    ssrTMarginBps: parseOptionalMarginBps(process.env.SSR_T_MARGIN_PTSUSDS_BPS, 'SSR_T_MARGIN_PTSUSDS_BPS'),
    maturityUtcSec: PT_SUSDS_MATURITY_UTC_SEC,
  },
  {
    name: 'WETH/USDS',
    collateral: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    oracle: (process.env.ORACLE_WETH || '0x0') as Address,
    lltv: BigInt(process.env.LLTV_WETH || LLTV_86_PERCENT),
    targetBps: parseTargetBps(process.env.TARGET_WETH_BPS, 0, 'TARGET_WETH_BPS'),
    maxUtilizationBps: WETH_MAX_UTILIZATION_BPS,
    mode: parseMarketMode(process.env.MODE_WETH, 'STEERED', 'MODE_WETH'),
    ssrTMarginBps: parseOptionalMarginBps(process.env.SSR_T_MARGIN_WETH_BPS, 'SSR_T_MARGIN_WETH_BPS'),
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
