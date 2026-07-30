import { describe, it, expect } from 'vitest';
import { parseBandConfig, computeSsrApy, assertSsrSane } from './band-config.js';

const WAD = 10n ** 18n;

// Minimal env: only the two REQUIRED step caps. Everything else defaults.
const REQUIRED = { MAX_ALLOCATE_USDS: '5000000', MAX_DEALLOCATE_USDS: '5000000' };

describe('parseBandConfig', () => {
  it('applies all DECIDED 2026-07-30 defaults when only required vars are set', () => {
    const cfg = parseBandConfig(REQUIRED);
    expect(cfg.lowFracNum).toBe(4n);
    expect(cfg.lowFracDen).toBe(7n);
    expect(cfg.highFracNum).toBe(8n);
    expect(cfg.highFracDen).toBe(7n);
    expect(cfg.ssrTMarginBps).toBe(15);
    expect(cfg.bandUtilHarvestBps).toBe(9000);
    expect(cfg.bandUtilHighBps).toBe(9200);
    expect(cfg.bandUtilMidBps).toBe(9300);
    expect(cfg.bandUtilDrainBps).toBe(9400);
    expect(cfg.utilDeadbandBps).toBe(50);
    expect(cfg.minBandActionUsds).toBe(30_000n * WAD);
    expect(cfg.sleeveFloorBps).toBe(1200);
    expect(cfg.soundingFirstTrancheUsds).toBe(3_000_000n * WAD);
    expect(cfg.soundingNextTrancheUsds).toBe(1_500_000n * WAD);
    expect(cfg.soundingStickUtilBps).toBe(9500);
    expect(cfg.soundingFeedCooldownHours).toBe(24);
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
      SSR_T_MARGIN_BPS: '25',
      BAND_UTIL_DRAIN_BPS: '9500',
      MIN_BAND_ACTION_USDS: '50000',
      SOUNDING_FEED_COOLDOWN_HOURS: '48',
      BAND_LOW_FRAC_NUM: '1',
      BAND_LOW_FRAC_DEN: '2',
    });
    expect(cfg.ssrTMarginBps).toBe(25);
    expect(cfg.bandUtilDrainBps).toBe(9500);
    expect(cfg.minBandActionUsds).toBe(50_000n * WAD);
    expect(cfg.soundingFeedCooldownHours).toBe(48);
    expect(cfg.lowFracNum).toBe(1n);
    expect(cfg.lowFracDen).toBe(2n);
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
      expect(() => parseBandConfig({ ...REQUIRED, BAND_UTIL_MID_BPS: '0x10' })).toThrow(/BAND_UTIL_MID_BPS/);
      expect(() => parseBandConfig({ ...REQUIRED, MAX_ALLOCATE_USDS: '1e6' })).toThrow(/MAX_ALLOCATE_USDS/);
    });

    it('rejects negatives', () => {
      expect(() => parseBandConfig({ ...REQUIRED, SOUNDING_FEED_COOLDOWN_HOURS: '-1' })).toThrow(/SOUNDING_FEED_COOLDOWN_HOURS/);
    });

    it('rejects bps values above 10000', () => {
      expect(() => parseBandConfig({ ...REQUIRED, MONOPOLIST_SHARE_BPS: '10001' })).toThrow(/MONOPOLIST_SHARE_BPS/);
    });
  });

  describe('cross-field validation', () => {
    it('throws when bands are not monotonic (harvest above high)', () => {
      expect(() => parseBandConfig({ ...REQUIRED, BAND_UTIL_HARVEST_BPS: '9250' })).toThrow(/monotonic/);
    });

    it('throws when bands are not monotonic (drain below mid)', () => {
      expect(() => parseBandConfig({ ...REQUIRED, BAND_UTIL_DRAIN_BPS: '9200' })).toThrow(/monotonic/);
    });

    it('throws when LOW fraction is not < HIGH fraction', () => {
      // 8/7 vs default HIGH 8/7 — equal, not strictly less
      expect(() => parseBandConfig({ ...REQUIRED, BAND_LOW_FRAC_NUM: '8' })).toThrow(/LOW.*HIGH/);
    });

    it('throws on a zero fraction denominator', () => {
      expect(() => parseBandConfig({ ...REQUIRED, BAND_LOW_FRAC_DEN: '0' })).toThrow(/BAND_LOW_FRAC_DEN/);
      expect(() => parseBandConfig({ ...REQUIRED, BAND_HIGH_FRAC_DEN: '0' })).toThrow(/BAND_HIGH_FRAC_DEN/);
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

  it('round-trips a 3.52% APY (the 2026-07-30 SSR)', () => {
    const perSecond = Math.pow(1.0352, 1 / 31_536_000);
    // Build the RAY at full double precision: integer part at 1e18 scale, then pad to 1e27.
    const ray = BigInt(Math.round(perSecond * 1e18)) * 1_000_000_000n;
    expect(computeSsrApy(ray)).toBeCloseTo(0.0352, 6);
  });
});

describe('assertSsrSane', () => {
  const cfg = parseBandConfig(REQUIRED); // bounds [100, 1500] bps

  it('accepts the 2026-07-30 SSR of 3.52%', () => {
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
