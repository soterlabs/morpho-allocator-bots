import { describe, it, expect } from 'vitest';
import { parseBandConfig, computeSsrApy, assertSsrSane } from './band-config.js';

const WAD = 10n ** 18n;

// Minimal env: only the two REQUIRED step caps. Everything else defaults.
const REQUIRED = { MAX_ALLOCATE_USDS: '5000000', MAX_DEALLOCATE_USDS: '5000000' };

describe('parseBandConfig', () => {
  it('applies the production defaults when only required vars are set', () => {
    const cfg = parseBandConfig(REQUIRED);
    expect(cfg.ssrTMarginBps).toBe(0);
    expect(cfg.ssrTToleranceBps).toBe(25);
    expect(cfg.utilDeadbandBps).toBe(50);
    expect(cfg.minBandActionUsds).toBe(10_000n * WAD);
    expect(cfg.minPriorityWithdrawalUsds).toBe(50_000n * WAD);
    expect(cfg.sleeveFloorBps).toBe(1500);
    expect(cfg.directionCooldownHours).toBe(24);
    expect(cfg.monopolistShareBps).toBe(8000);
    expect(cfg.ssrMinApyBps).toBe(100);
    expect(cfg.ssrMaxApyBps).toBe(1500);
    expect(cfg.maxAllocateUsds).toBe(5_000_000n * WAD);
    expect(cfg.maxDeallocateUsds).toBe(5_000_000n * WAD);
  });

  it('honors explicit overrides (whole-USDS envs are converted to 18-dec)', () => {
    const cfg = parseBandConfig({
      ...REQUIRED,
      SSR_T_MARGIN_BPS: '40',
      SSR_T_TOLERANCE_BPS: '30',
      MIN_BAND_ACTION_USDS: '100000',
      SLEEVE_FLOOR_BPS: '1600',
    });
    expect(cfg.ssrTMarginBps).toBe(40);
    expect(cfg.ssrTToleranceBps).toBe(30);
    expect(cfg.minBandActionUsds).toBe(100_000n * WAD);
    expect(cfg.sleeveFloorBps).toBe(1600);
  });

  describe('MIN_BAND_ACTION_USDS', () => {
    it('defaults to 10k USDS (18-dec)', () => {
      expect(parseBandConfig(REQUIRED).minBandActionUsds).toBe(10_000n * WAD);
    });

    it('honors an explicit override in whole USDS', () => {
      const cfg = parseBandConfig({ ...REQUIRED, MIN_BAND_ACTION_USDS: '100000' });
      expect(cfg.minBandActionUsds).toBe(100_000n * WAD);
    });
  });

  describe('MIN_PRIORITY_WITHDRAWAL_USDS', () => {
    it('defaults to 50k USDS (18-dec)', () => {
      expect(parseBandConfig(REQUIRED).minPriorityWithdrawalUsds).toBe(50_000n * WAD);
    });

    it('honors an explicit override in whole USDS', () => {
      const cfg = parseBandConfig({ ...REQUIRED, MIN_PRIORITY_WITHDRAWAL_USDS: '25000' });
      expect(cfg.minPriorityWithdrawalUsds).toBe(25_000n * WAD);
    });

    it('accepts 0 (every breach drains immediately)', () => {
      expect(parseBandConfig({ ...REQUIRED, MIN_PRIORITY_WITHDRAWAL_USDS: '0' }).minPriorityWithdrawalUsds).toBe(0n);
    });

    it('rejects non-canonical values instead of defaulting', () => {
      expect(() => parseBandConfig({ ...REQUIRED, MIN_PRIORITY_WITHDRAWAL_USDS: '50000.5' })).toThrow(/MIN_PRIORITY_WITHDRAWAL_USDS/);
      expect(() => parseBandConfig({ ...REQUIRED, MIN_PRIORITY_WITHDRAWAL_USDS: '' })).toThrow(/MIN_PRIORITY_WITHDRAWAL_USDS/);
      expect(() => parseBandConfig({ ...REQUIRED, MIN_PRIORITY_WITHDRAWAL_USDS: '5e4' })).toThrow(/MIN_PRIORITY_WITHDRAWAL_USDS/);
      expect(() => parseBandConfig({ ...REQUIRED, MIN_PRIORITY_WITHDRAWAL_USDS: '-1' })).toThrow(/MIN_PRIORITY_WITHDRAWAL_USDS/);
    });

    it('refuses a MAX_DEALLOCATE_USDS step cap below the priority-withdrawal min (breaches could never drain)', () => {
      // 40k step cap clears the 10k min action but not the 50k priority-withdrawal
      // default: every cap-breach drain would be clamped under its own drop threshold
      // and dropped, cycle after cycle.
      expect(() => parseBandConfig({ ...REQUIRED, MAX_DEALLOCATE_USDS: '40000' }))
        .toThrow(/MAX_DEALLOCATE_USDS must be >= MIN_PRIORITY_WITHDRAWAL_USDS/);
    });

    it('accepts a MAX_DEALLOCATE_USDS step cap exactly at the priority-withdrawal min', () => {
      const cfg = parseBandConfig({ ...REQUIRED, MAX_DEALLOCATE_USDS: '50000' });
      expect(cfg.maxDeallocateUsds).toBe(cfg.minPriorityWithdrawalUsds);
    });
  });

  describe('required step caps', () => {
    it('throws when MAX_ALLOCATE_USDS is missing', () => {
      expect(() => parseBandConfig({ MAX_DEALLOCATE_USDS: '5000000' })).toThrow(/MAX_ALLOCATE_USDS/);
    });

    it('throws when MAX_DEALLOCATE_USDS is missing', () => {
      expect(() => parseBandConfig({ MAX_ALLOCATE_USDS: '5000000' })).toThrow(/MAX_DEALLOCATE_USDS/);
    });

    it('throws when a step cap is zero (step caps must be > 0)', () => {
      expect(() => parseBandConfig({ ...REQUIRED, MAX_DEALLOCATE_USDS: '0' })).toThrow(/MAX_DEALLOCATE_USDS.*> 0/);
      expect(() => parseBandConfig({ ...REQUIRED, MAX_ALLOCATE_USDS: '0' })).toThrow(/MAX_ALLOCATE_USDS.*> 0/);
    });
  });

  describe('strict value parsing (parseTargetBps model)', () => {
    it('rejects decimals', () => {
      expect(() => parseBandConfig({ ...REQUIRED, MIN_BAND_ACTION_USDS: '1.5' })).toThrow(/MIN_BAND_ACTION_USDS/);
    });

    it('rejects empty strings (present-but-empty is NOT "unset")', () => {
      expect(() => parseBandConfig({ ...REQUIRED, SSR_T_MARGIN_BPS: '' })).toThrow(/SSR_T_MARGIN_BPS/);
    });

    it('rejects non-decimal forms', () => {
      expect(() => parseBandConfig({ ...REQUIRED, SSR_T_TOLERANCE_BPS: '0x10' })).toThrow(/SSR_T_TOLERANCE_BPS/);
      expect(() => parseBandConfig({ ...REQUIRED, MAX_ALLOCATE_USDS: '1e6' })).toThrow(/MAX_ALLOCATE_USDS/);
    });

    it('rejects negatives', () => {
      expect(() => parseBandConfig({ ...REQUIRED, DIRECTION_COOLDOWN_HOURS: '-1' })).toThrow(/DIRECTION_COOLDOWN_HOURS/);
    });

    it('rejects bps values above 10000', () => {
      expect(() => parseBandConfig({ ...REQUIRED, MONOPOLIST_SHARE_BPS: '10001' })).toThrow(/MONOPOLIST_SHARE_BPS/);
    });
  });

  describe('cross-field validation', () => {
    it('accepts a tolerance wider than the margin (the zone may dip below SSR)', () => {
      // The production shape: margin 0, tolerance 25 -> zone [SSR - 25, SSR + 25] bps.
      const cfg = parseBandConfig({ ...REQUIRED, SSR_T_MARGIN_BPS: '0', SSR_T_TOLERANCE_BPS: '25' });
      expect(cfg.ssrTMarginBps).toBe(0);
      expect(cfg.ssrTToleranceBps).toBe(25);
    });

    it('throws when the sleeve floor is not < 2000 bps', () => {
      expect(() => parseBandConfig({ ...REQUIRED, SLEEVE_FLOOR_BPS: '2000' })).toThrow(/SLEEVE_FLOOR_BPS/);
    });

    it('accepts a sleeve floor of 1999 bps', () => {
      expect(parseBandConfig({ ...REQUIRED, SLEEVE_FLOOR_BPS: '1999' }).sleeveFloorBps).toBe(1999);
    });

    it('throws when SSR sanity bounds are not ordered', () => {
      expect(() => parseBandConfig({ ...REQUIRED, SSR_MIN_APY_BPS: '1500' })).toThrow(/SSR_MIN_APY_BPS/);
    });

    it('throws when a step cap is below the min action (the bot could never act)', () => {
      // 9999 is one USDS under the 10k default on either side.
      expect(() => parseBandConfig({ ...REQUIRED, MAX_ALLOCATE_USDS: '9999' })).toThrow(/MIN_BAND_ACTION_USDS/);
      expect(() => parseBandConfig({ ...REQUIRED, MAX_DEALLOCATE_USDS: '9999' })).toThrow(/MIN_BAND_ACTION_USDS/);
    });

    it('accepts a step cap equal to the min action', () => {
      // MAX_ALLOCATE has no other lower bound (MAX_DEALLOCATE also answers to the
      // 50k priority-withdrawal min), so it can sit exactly on the 10k default.
      const cfg = parseBandConfig({ ...REQUIRED, MAX_ALLOCATE_USDS: '10000' });
      expect(cfg.maxAllocateUsds).toBe(cfg.minBandActionUsds);
    });

    it('accepts a MAX_DEALLOCATE_USDS step cap equal to a min action raised above the priority-withdrawal min', () => {
      const cfg = parseBandConfig({ ...REQUIRED, MIN_BAND_ACTION_USDS: '100000', MAX_DEALLOCATE_USDS: '100000' });
      expect(cfg.maxDeallocateUsds).toBe(100_000n * WAD);
    });
  });
});

describe('computeSsrApy', () => {
  it('returns 0 for a per-second rate of exactly RAY (no growth)', () => {
    expect(computeSsrApy(10n ** 27n)).toBe(0);
  });

  it('converts the well-known 5% per-second rate to ~5% APY', () => {
    // (1.05)^(1/31536000) in RAY — the canonical Sky/Maker 5% rate constant.
    expect(computeSsrApy(1000000001547125957863212448n)).toBeCloseTo(0.05, 6);
  });

  it('round-trips a 3.52% APY (the current SSR)', () => {
    // (1.0352)^(1/31536000) in RAY — the per-second rate whose APY is 3.52%.
    expect(computeSsrApy(1000000001096988928000000000n)).toBeCloseTo(0.0352, 6);
  });
});

describe('assertSsrSane', () => {
  const cfg = parseBandConfig(REQUIRED); // bounds [100, 1500] bps

  it('accepts the current SSR of 3.52%', () => {
    expect(() => assertSsrSane(0.0352, cfg)).not.toThrow();
  });

  it('accepts the inclusive bounds (1% and 15%)', () => {
    expect(() => assertSsrSane(0.01, cfg)).not.toThrow();
    expect(() => assertSsrSane(0.15, cfg)).not.toThrow();
  });

  it('throws below the lower bound', () => {
    expect(() => assertSsrSane(0.0099, cfg)).toThrow(/sanity bounds/);
    expect(() => assertSsrSane(0, cfg)).toThrow(/sanity bounds/);
    // a garbage ssr() read of 0 becomes APY -1 — must abort
    expect(() => assertSsrSane(computeSsrApy(0n), cfg)).toThrow(/sanity bounds/);
  });

  it('throws above the upper bound', () => {
    expect(() => assertSsrSane(0.1501, cfg)).toThrow(/sanity bounds/);
  });

  it('throws on non-finite values', () => {
    expect(() => assertSsrSane(Number.NaN, cfg)).toThrow(/sanity bounds/);
    expect(() => assertSsrSane(Number.POSITIVE_INFINITY, cfg)).toThrow(/sanity bounds/);
  });
});
