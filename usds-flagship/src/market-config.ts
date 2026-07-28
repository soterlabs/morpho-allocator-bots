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
