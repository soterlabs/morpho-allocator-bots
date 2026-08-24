import { describe, it, expect } from 'vitest';
import { parseEther, type Address } from 'viem';
import {
  computeMarketCap, parseMarketMode, validateBandsMarkets, validateBpsMarkets, type MarketConfig,
} from './market-config.js';

const LLTV_86_PERCENT = 860000000000000000n;

/**
 * A cbBTC/USDS-shaped STEERED market with no bands-mode caps; tests add capUsds/capBps
 * (or a different mode) per scenario.
 */
function market(name: string, overrides: Partial<MarketConfig> = {}): MarketConfig {
  return {
    name,
    collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address,
    oracle: '0x0' as Address,
    lltv: LLTV_86_PERCENT,
    targetBps: 0,
    mode: 'STEERED',
    ...overrides,
  };
}

// Production-shaped caps: 5M absolute, 10% of totalAssets.
const CAPPED = { capUsds: parseEther('5000000'), capBps: 1000 };

describe('parseMarketMode', () => {
  it('returns the default only when the env var is unset', () => {
    expect(parseMarketMode(undefined, 'RETIRED', 'MODE_STUSDS')).toBe('RETIRED');
    expect(parseMarketMode(undefined, 'STEERED', 'MODE_CBBTC')).toBe('STEERED');
  });

  it('parses explicit STEERED and RETIRED, tolerating whitespace', () => {
    expect(parseMarketMode('STEERED', 'RETIRED', 'MODE_STUSDS')).toBe('STEERED');
    expect(parseMarketMode(' RETIRED ', 'STEERED', 'MODE_WETH')).toBe('RETIRED');
  });

  it('accepts PRIMARY', () => {
    expect(parseMarketMode('PRIMARY', 'STEERED', 'MODE_PTSUSDS')).toBe('PRIMARY');
  });

  it('refuses to start on SOUNDING and names the modes that do work', () => {
    expect(() => parseMarketMode('SOUNDING', 'STEERED', 'MODE_PTSUSDS'))
      .toThrow(/MODE_PTSUSDS=SOUNDING is not implemented — use STEERED, PRIMARY or RETIRED/);
  });

  it('throws on anything outside the mode enum instead of defaulting', () => {
    expect(() => parseMarketMode('steered', 'STEERED', 'MODE_CBBTC')).toThrow(/MODE_CBBTC/);
    expect(() => parseMarketMode('', 'STEERED', 'MODE_CBBTC')).toThrow(/MODE_CBBTC/);
    expect(() => parseMarketMode('RETIRD', 'STEERED', 'MODE_CBBTC')).toThrow(/MODE_CBBTC/);
  });
});

describe('validateBandsMarkets', () => {
  it('throws on two PRIMARY markets, naming both', () => {
    const table = [
      market('PT-sUSDS/USDS', { mode: 'PRIMARY', ...CAPPED }),
      market('cbBTC/USDS', { mode: 'PRIMARY', ...CAPPED }),
    ];
    expect(() => validateBandsMarkets(table)).toThrow(/PT-sUSDS\/USDS, cbBTC\/USDS.*at most one/);
  });

  it('passes without any env caps (caps are optional, as in bps mode)', () => {
    const table = [
      market('stUSDS/USDS', { mode: 'RETIRED' }),
      market('cbBTC/USDS'),
      market('PT-sUSDS/USDS', { mode: 'PRIMARY' }),
    ];
    expect(() => validateBandsMarkets(table)).not.toThrow();
  });

  it('passes with exactly one PRIMARY market among capped STEERED markets', () => {
    const table = [
      market('cbBTC/USDS', CAPPED),
      market('wstETH/USDS', CAPPED),
      market('PT-sUSDS/USDS', { mode: 'PRIMARY', ...CAPPED }),
    ];
    expect(() => validateBandsMarkets(table)).not.toThrow();
  });
});

describe('validateBpsMarkets', () => {
  it('throws on any PRIMARY market, naming it', () => {
    const table = [
      market('cbBTC/USDS'),
      market('PT-sUSDS/USDS', { mode: 'PRIMARY' }),
    ];
    expect(() => validateBpsMarkets(table)).toThrow(/PT-sUSDS\/USDS.*PRIMARY/);
  });

  it('passes with only STEERED and RETIRED markets', () => {
    const table = [
      market('stUSDS/USDS', { mode: 'RETIRED' }),
      market('cbBTC/USDS'),
    ];
    expect(() => validateBpsMarkets(table)).not.toThrow();
  });
});

describe('computeMarketCap', () => {
  it('binds on the relative cap when capBps x totalAssets is below capUsds', () => {
    // 10% of a 40.4M vault = 4.04M < 5M.
    const cap = computeMarketCap(market('PT-sUSDS/USDS', CAPPED), parseEther('40400000'));
    expect(cap).toBe(parseEther('4040000'));
  });

  it('binds on the absolute cap when capBps x totalAssets exceeds capUsds', () => {
    // 10% of a 60M vault = 6M > 5M.
    const cap = computeMarketCap(market('PT-sUSDS/USDS', CAPPED), parseEther('60000000'));
    expect(cap).toBe(parseEther('5000000'));
  });

  it('returns 0 for a zero absolute cap (the market must hold nothing)', () => {
    const cap = computeMarketCap(market('WETH/USDS', { capUsds: 0n, capBps: 1000 }), parseEther('40400000'));
    expect(cap).toBe(0n);
  });

  it('is the share cap alone when only capBps is set', () => {
    expect(computeMarketCap(market('cbBTC/USDS', { capBps: 1000 }), parseEther('40400000')))
      .toBe(parseEther('4040000'));
  });

  it('is the amount cap alone when only capUsds is set', () => {
    expect(computeMarketCap(market('cbBTC/USDS', { capUsds: parseEther('5000000') }), parseEther('40400000')))
      .toBe(parseEther('5000000'));
  });

  it('falls back to the bps-mode absoluteCap when capUsds is unset (PT-sUSDS keeps its 5M)', () => {
    const pt = market('PT-sUSDS/USDS', { absoluteCap: parseEther('5000000'), capBps: 1000 });
    expect(computeMarketCap(pt, parseEther('60000000'))).toBe(parseEther('5000000'));
  });

  it('prefers an explicit capUsds over the absoluteCap fallback', () => {
    const pt = market('PT-sUSDS/USDS', { absoluteCap: parseEther('5000000'), capUsds: parseEther('3000000') });
    expect(computeMarketCap(pt, parseEther('60000000'))).toBe(parseEther('3000000'));
  });

  it('is undefined for a market with no cap at all (bounded by the on-chain cap only)', () => {
    expect(computeMarketCap(market('cbBTC/USDS'), parseEther('40400000'))).toBeUndefined();
  });
});
