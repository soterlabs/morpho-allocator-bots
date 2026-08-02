import { describe, it, expect } from 'vitest';
import { parseMarketMode } from './market-config.js';

describe('parseMarketMode', () => {
  it('returns the default only when the env var is unset', () => {
    expect(parseMarketMode(undefined, 'RETIRED', 'MODE_STUSDS')).toBe('RETIRED');
    expect(parseMarketMode(undefined, 'STEERED', 'MODE_CBBTC')).toBe('STEERED');
  });

  it('parses explicit STEERED and RETIRED, tolerating whitespace', () => {
    expect(parseMarketMode('STEERED', 'RETIRED', 'MODE_STUSDS')).toBe('STEERED');
    expect(parseMarketMode(' RETIRED ', 'STEERED', 'MODE_WETH')).toBe('RETIRED');
  });

  it('refuses to start on SOUNDING (recognized name, not implemented)', () => {
    expect(() => parseMarketMode('SOUNDING', 'STEERED', 'MODE_PTSUSDS'))
      .toThrow(/SOUNDING is not implemented/);
  });

  it('throws on anything outside the mode enum instead of defaulting', () => {
    expect(() => parseMarketMode('steered', 'STEERED', 'MODE_CBBTC')).toThrow(/MODE_CBBTC/);
    expect(() => parseMarketMode('', 'STEERED', 'MODE_CBBTC')).toThrow(/MODE_CBBTC/);
    expect(() => parseMarketMode('RETIRD', 'STEERED', 'MODE_CBBTC')).toThrow(/MODE_CBBTC/);
  });
});
