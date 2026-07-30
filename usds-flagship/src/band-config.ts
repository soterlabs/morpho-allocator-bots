/**
 * Band-steering configuration for the Flagship Vault Allocator Bot (Phase A "band steering").
 *
 * In bands mode (ALLOCATION_MODE=bands) the 20% sleeve is steered by per-market
 * utilization bands derived from the on-chain Sky Savings Rate instead of static bps
 * targets. This module owns:
 *
 *   - the BandConfig shape and its env parsing/validation (parseBandConfig),
 *   - the SSR RAY -> APY conversion (computeSsrApy),
 *   - the SSR sanity bounds (assertSsrSane) — a bad SSR read must abort the cycle.
 *
 * All defaults are the DECIDED 2026-07-30 parameters. Defaulting here DOCUMENTS the
 * decision rather than masking misconfiguration (per the repo's fail-loud ground rule):
 * every default is a deliberately chosen production value, and the two step caps
 * (MAX_ALLOCATE_USDS / MAX_DEALLOCATE_USDS) have NO default and are required, because
 * they bound the worst-case fund movement of a single cron cycle.
 *
 * SSR source: sUSDS.ssr() at 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD — a per-second
 * growth factor in RAY (1e27), e.g. ~1.000000001097e27 for a 3.52% APY.
 * APY = (ssr / 1e27) ^ 31_536_000 - 1.
 */

/**
 * How the bot treats a market in bands mode:
 *   STEERED  — actively steered to a utilization band derived from SSR.
 *   SOUNDING — depth-sounding a new market: feed fixed tranches while demand "sticks"
 *              (utilization stays pinned); never drains.
 *   RETIRED  — drain to zero (sweep semantics).
 */
export type MarketMode = 'STEERED' | 'SOUNDING' | 'RETIRED';

export interface BandConfig {
  lowFracNum: bigint; lowFracDen: bigint;        // 4n, 7n — LOW threshold = 4/7 x SSR
  highFracNum: bigint; highFracDen: bigint;      // 8n, 7n — HIGH threshold = 8/7 x SSR
  ssrTMarginBps: number;                          // 15 — SSR_t = SSR + margin
  bandUtilHarvestBps: number;                     // 9000
  bandUtilHighBps: number;                        // 9200
  bandUtilMidBps: number;                         // 9300
  bandUtilDrainBps: number;                       // 9400
  utilDeadbandBps: number;                        // 50
  minBandActionUsds: bigint;                      // 30000e18
  sleeveFloorBps: number;                         // 1200 — hard sleeve floor, 12% of totalAssets
  soundingFirstTrancheUsds: bigint;               // 3000000e18
  soundingNextTrancheUsds: bigint;                // 1500000e18
  soundingStickUtilBps: number;                   // 9500
  soundingFeedCooldownHours: number;              // 24
  directionCooldownHours: number;                 // 24
  monopolistShareBps: number;                     // 8000
  ssrMinApyBps: number;                           // 100
  ssrMaxApyBps: number;                           // 1500
  maxAllocateUsds: bigint;                        // REQUIRED env
  maxDeallocateUsds: bigint;                      // REQUIRED env
}

const USDS_WAD = 10n ** 18n; // USDS has 18 decimals
const RAY = 1e27;            // sUSDS.ssr() precision
const SECONDS_PER_YEAR = 31_536_000; // 365 days — matches the ssr() compounding convention

/**
 * Parse a basis-points env value in [0, 10000]. Same contract as parseTargetBps in
 * allocation-logic.ts: returns `defaultBps` ONLY when unset; any present value that is
 * not a canonical whole number throws (rejects "", "0x10", "1e3", negatives, decimals).
 */
function parseBps(raw: string | undefined, defaultBps: number, label: string): number {
  if (raw === undefined) return defaultBps;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number of basis points in [0, 10000], got "${raw}"`);
  }
  const value = Number(trimmed);
  if (value > 10000) {
    throw new Error(`${label} must be <= 10000 basis points, got "${raw}"`);
  }
  return value;
}

/**
 * Parse a plain non-negative whole-number env value (e.g. cooldown hours).
 * Returns the default ONLY when unset; anything non-canonical throws.
 */
function parseWholeNumber(raw: string | undefined, defaultValue: number, label: string): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a non-negative whole number, got "${raw}"`);
  }
  return Number(trimmed);
}

/**
 * Parse a threshold-fraction part (numerator or denominator) as bigint.
 * Returns the default ONLY when unset; anything non-canonical throws.
 * Denominator positivity is validated in parseBandConfig (needs both parts).
 */
function parseFracPart(raw: string | undefined, defaultValue: bigint, label: string): bigint {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a non-negative whole number, got "${raw}"`);
  }
  return BigInt(trimmed);
}

/**
 * Parse an amount env expressed in WHOLE USDS (e.g. "30000" = $30k) into 18-dec units.
 * `defaultWholeUsds` is also in whole USDS. Returns the default ONLY when unset;
 * any present non-canonical value throws.
 */
function parseWholeUsds(raw: string | undefined, defaultWholeUsds: bigint, label: string): bigint {
  if (raw === undefined) return defaultWholeUsds * USDS_WAD;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number of USDS (18-dec conversion is internal), got "${raw}"`);
  }
  return BigInt(trimmed) * USDS_WAD;
}

/**
 * Parse a REQUIRED, strictly-positive whole-USDS env into 18-dec units.
 * Used for the per-cycle step caps: they bound the worst-case fund movement of a single
 * cron run, so bands mode refuses to start without them (no default, 0 rejected).
 */
function parseRequiredPositiveUsds(raw: string | undefined, label: string): bigint {
  if (raw === undefined) {
    throw new Error(
      `${label} is REQUIRED in bands mode (whole USDS, > 0) and has no default — ` +
      `it bounds the worst-case fund movement of a single cycle`
    );
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number of USDS, got "${raw}"`);
  }
  const value = BigInt(trimmed) * USDS_WAD;
  if (value <= 0n) {
    throw new Error(`${label} must be > 0 USDS, got "${raw}"`);
  }
  return value;
}

/**
 * Parse and validate the full band-steering configuration from an env record.
 *
 * Env vars (defaults are the DECIDED 2026-07-30 values):
 *   BAND_LOW_FRAC_NUM / BAND_LOW_FRAC_DEN     — LOW rate threshold as a fraction of SSR (4/7)
 *   BAND_HIGH_FRAC_NUM / BAND_HIGH_FRAC_DEN   — HIGH rate threshold as a fraction of SSR (8/7)
 *   SSR_T_MARGIN_BPS                          — SSR_t = SSR + margin (15)
 *   BAND_UTIL_HARVEST_BPS / _HIGH_BPS / _MID_BPS / _DRAIN_BPS — held-utilization bands
 *                                               (9000 / 9200 / 9300 / 9400)
 *   UTIL_DEADBAND_BPS                         — no action within +-deadband of the band (50)
 *   MIN_BAND_ACTION_USDS                      — min steering action, whole USDS (30000)
 *   SLEEVE_FLOOR_BPS                          — hard sleeve floor as bps of totalAssets (1200)
 *   SOUNDING_FIRST_TRANCHE_USDS / SOUNDING_NEXT_TRANCHE_USDS — whole USDS (3000000 / 1500000)
 *   SOUNDING_STICK_UTIL_BPS                   — feed only while util >= this (9500)
 *   SOUNDING_FEED_COOLDOWN_HOURS              — min hours between feeds (24)
 *   DIRECTION_COOLDOWN_HOURS                  — min hours before reversing direction (24)
 *   MONOPOLIST_SHARE_BPS                      — drains only when vault share >= this (8000)
 *   SSR_MIN_APY_BPS / SSR_MAX_APY_BPS         — SSR sanity bounds, abort outside (100 / 1500)
 *   MAX_ALLOCATE_USDS / MAX_DEALLOCATE_USDS   — REQUIRED per-cycle step caps, whole USDS, no default
 *
 * Throws on any invalid or missing-required value. Cross-field validation:
 *   - band monotonicity: drain >= mid >= high >= harvest, harvest > 0 (band 0 would make
 *     the utilization inversion divide by zero)
 *   - LOW fraction < HIGH fraction (cross-multiplied, exact bigint comparison)
 *   - sleeve floor < 2000 bps (the sleeve is 20%; a floor at/above it is nonsensical)
 *   - SSR sanity bounds ordered (min < max)
 *   - step caps > 0 (enforced by the required parser)
 */
export function parseBandConfig(env: Record<string, string | undefined>): BandConfig {
  const cfg: BandConfig = {
    lowFracNum: parseFracPart(env.BAND_LOW_FRAC_NUM, 4n, 'BAND_LOW_FRAC_NUM'),
    lowFracDen: parseFracPart(env.BAND_LOW_FRAC_DEN, 7n, 'BAND_LOW_FRAC_DEN'),
    highFracNum: parseFracPart(env.BAND_HIGH_FRAC_NUM, 8n, 'BAND_HIGH_FRAC_NUM'),
    highFracDen: parseFracPart(env.BAND_HIGH_FRAC_DEN, 7n, 'BAND_HIGH_FRAC_DEN'),
    ssrTMarginBps: parseBps(env.SSR_T_MARGIN_BPS, 15, 'SSR_T_MARGIN_BPS'),
    bandUtilHarvestBps: parseBps(env.BAND_UTIL_HARVEST_BPS, 9000, 'BAND_UTIL_HARVEST_BPS'),
    bandUtilHighBps: parseBps(env.BAND_UTIL_HIGH_BPS, 9200, 'BAND_UTIL_HIGH_BPS'),
    bandUtilMidBps: parseBps(env.BAND_UTIL_MID_BPS, 9300, 'BAND_UTIL_MID_BPS'),
    bandUtilDrainBps: parseBps(env.BAND_UTIL_DRAIN_BPS, 9400, 'BAND_UTIL_DRAIN_BPS'),
    utilDeadbandBps: parseBps(env.UTIL_DEADBAND_BPS, 50, 'UTIL_DEADBAND_BPS'),
    minBandActionUsds: parseWholeUsds(env.MIN_BAND_ACTION_USDS, 30_000n, 'MIN_BAND_ACTION_USDS'),
    sleeveFloorBps: parseBps(env.SLEEVE_FLOOR_BPS, 1200, 'SLEEVE_FLOOR_BPS'),
    soundingFirstTrancheUsds: parseWholeUsds(env.SOUNDING_FIRST_TRANCHE_USDS, 3_000_000n, 'SOUNDING_FIRST_TRANCHE_USDS'),
    soundingNextTrancheUsds: parseWholeUsds(env.SOUNDING_NEXT_TRANCHE_USDS, 1_500_000n, 'SOUNDING_NEXT_TRANCHE_USDS'),
    soundingStickUtilBps: parseBps(env.SOUNDING_STICK_UTIL_BPS, 9500, 'SOUNDING_STICK_UTIL_BPS'),
    soundingFeedCooldownHours: parseWholeNumber(env.SOUNDING_FEED_COOLDOWN_HOURS, 24, 'SOUNDING_FEED_COOLDOWN_HOURS'),
    directionCooldownHours: parseWholeNumber(env.DIRECTION_COOLDOWN_HOURS, 24, 'DIRECTION_COOLDOWN_HOURS'),
    monopolistShareBps: parseBps(env.MONOPOLIST_SHARE_BPS, 8000, 'MONOPOLIST_SHARE_BPS'),
    ssrMinApyBps: parseBps(env.SSR_MIN_APY_BPS, 100, 'SSR_MIN_APY_BPS'),
    ssrMaxApyBps: parseBps(env.SSR_MAX_APY_BPS, 1500, 'SSR_MAX_APY_BPS'),
    maxAllocateUsds: parseRequiredPositiveUsds(env.MAX_ALLOCATE_USDS, 'MAX_ALLOCATE_USDS'),
    maxDeallocateUsds: parseRequiredPositiveUsds(env.MAX_DEALLOCATE_USDS, 'MAX_DEALLOCATE_USDS'),
  };

  if (cfg.lowFracDen <= 0n) {
    throw new Error(`BAND_LOW_FRAC_DEN must be > 0, got ${cfg.lowFracDen}`);
  }
  if (cfg.highFracDen <= 0n) {
    throw new Error(`BAND_HIGH_FRAC_DEN must be > 0, got ${cfg.highFracDen}`);
  }
  // LOW < HIGH via cross-multiplication (exact, no float division).
  if (cfg.lowFracNum * cfg.highFracDen >= cfg.highFracNum * cfg.lowFracDen) {
    throw new Error(
      `LOW threshold fraction (${cfg.lowFracNum}/${cfg.lowFracDen}) must be < ` +
      `HIGH threshold fraction (${cfg.highFracNum}/${cfg.highFracDen})`
    );
  }
  if (!(
    cfg.bandUtilDrainBps >= cfg.bandUtilMidBps &&
    cfg.bandUtilMidBps >= cfg.bandUtilHighBps &&
    cfg.bandUtilHighBps >= cfg.bandUtilHarvestBps
  )) {
    throw new Error(
      `Utilization bands must be monotonic (drain >= mid >= high >= harvest), got ` +
      `drain=${cfg.bandUtilDrainBps} mid=${cfg.bandUtilMidBps} ` +
      `high=${cfg.bandUtilHighBps} harvest=${cfg.bandUtilHarvestBps}`
    );
  }
  if (cfg.bandUtilHarvestBps <= 0) {
    throw new Error(
      `BAND_UTIL_HARVEST_BPS must be > 0 (a zero band makes the supply inversion divide by zero), ` +
      `got ${cfg.bandUtilHarvestBps}`
    );
  }
  if (cfg.sleeveFloorBps >= 2000) {
    throw new Error(
      `SLEEVE_FLOOR_BPS must be < 2000 (the floor lives inside the 20% sleeve), got ${cfg.sleeveFloorBps}`
    );
  }
  if (cfg.ssrMinApyBps >= cfg.ssrMaxApyBps) {
    throw new Error(
      `SSR sanity bounds must be ordered: SSR_MIN_APY_BPS (${cfg.ssrMinApyBps}) < SSR_MAX_APY_BPS (${cfg.ssrMaxApyBps})`
    );
  }

  return cfg;
}

/**
 * Convert sUSDS.ssr() (per-second growth factor in RAY, 1e27) to an APY fraction:
 *
 *   APY = (ssr / 1e27) ^ 31_536_000 - 1     (e.g. 0.0352 for 3.52%)
 *
 * Precision note: Number(ssrRay) rounds the 28-digit RAY to a ~16-significant-digit
 * double (relative error ~1e-16). Exponentiation amplifies that by ~3.15e7, leaving a
 * relative APY error of ~3e-9 — far below the 1 bps granularity anything downstream
 * uses, so a float implementation is deliberate and sufficient.
 *
 * A garbage read (0, or a rate below RAY) yields an APY <= 0 which assertSsrSane
 * rejects — always call assertSsrSane on the result before steering.
 */
export function computeSsrApy(ssrRay: bigint): number {
  const perSecond = Number(ssrRay) / RAY;
  return Math.pow(perSecond, SECONDS_PER_YEAR) - 1;
}

/**
 * Abort the cycle if the SSR APY reads outside the configured sanity bounds
 * [ssrMinApyBps, ssrMaxApyBps] (defaults [100, 1500] bps = [1%, 15%], inclusive).
 *
 * The whole band ladder is proportional to SSR, so a corrupted read (proxy upgrade,
 * ABI drift, RPC garbage) would silently re-derive every threshold — better to throw
 * and skip the cycle than steer the sleeve off a bogus anchor. NaN/Infinity also throw.
 */
export function assertSsrSane(ssrApy: number, cfg: BandConfig): void {
  const min = cfg.ssrMinApyBps / 10000;
  const max = cfg.ssrMaxApyBps / 10000;
  if (!Number.isFinite(ssrApy) || ssrApy < min || ssrApy > max) {
    throw new Error(
      `SSR APY ${(ssrApy * 100).toFixed(4)}% is outside sanity bounds ` +
      `[${cfg.ssrMinApyBps}, ${cfg.ssrMaxApyBps}] bps — refusing to steer off a suspect read`
    );
  }
}
