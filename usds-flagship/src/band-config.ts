/**
 * Band-steering configuration for the Flagship Vault Allocator Bot.
 *
 * In bands mode (ALLOCATION_MODE=bands) the allocated sleeve is steered by
 * per-market utilization bands chosen from satAPY against thresholds derived
 * from the on-chain Sky Savings Rate (see band-controller.ts). This module
 * owns:
 *
 *   - the BandConfig shape and its env parsing/validation (parseBandConfig),
 *   - the SSR RAY -> APY conversion (computeSsrApy),
 *   - the SSR sanity bounds (assertSsrSane) — a bad SSR read must abort the cycle.
 *
 * Every default is a deliberately chosen production value; defaulting here
 * documents the decision rather than masking misconfiguration (per the repo's
 * fail-loud ground rule). The two step caps (MAX_ALLOCATE_USDS /
 * MAX_DEALLOCATE_USDS) have NO default and are required, because they bound
 * the worst-case fund movement of a single cron cycle.
 *
 * SSR source: sUSDS.ssr() at 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD — a
 * per-second growth factor in RAY (1e27), e.g. ~1.000000001097e27 for a 3.52%
 * APY. APY = (ssr / 1e27) ^ 31_536_000 - 1.
 */

/**
 * How the bot treats a market in bands mode:
 *   STEERED  — steered to a utilization band chosen from satAPY vs SSR_t.
 *   SOUNDING — reserved; configuring it refuses to start (see parseMarketMode).
 *   RETIRED  — the bot never touches the market.
 */
export type MarketMode = 'STEERED' | 'SOUNDING' | 'RETIRED';

export interface BandConfig {
  ssrTMarginBps: number;       // SSR_t = SSR + margin
  ssrTToleranceBps: number;    // HOLD zone = SSR_t +- tolerance
  utilDeadbandBps: number;     // no action within +-deadband of the band
  minBandActionUsds: bigint;   // smaller legs are dropped
  sleeveFloorBps: number;      // hard floor on the allocated sleeve, bps of totalAssets
  directionCooldownHours: number;
  monopolistShareBps: number;  // drains allowed only at/above this vault share
  ssrMinApyBps: number;        // SSR sanity bounds — abort the cycle outside them
  ssrMaxApyBps: number;
  maxAllocateUsds: bigint;     // REQUIRED per-cycle step caps
  maxDeallocateUsds: bigint;
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
 * Parse an amount env expressed in WHOLE USDS (e.g. "100000" = $100k) into 18-dec units.
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
 * Env vars and defaults:
 *   SSR_T_MARGIN_BPS            — SSR_t = SSR + margin (25)
 *   SSR_T_TOLERANCE_BPS         — HOLD zone half-width around SSR_t (25)
 *   UTIL_DEADBAND_BPS           — no action within +-deadband of the band (50)
 *   MIN_BAND_ACTION_USDS        — smaller legs are dropped, whole USDS (100000)
 *   SLEEVE_FLOOR_BPS            — hard sleeve floor as bps of totalAssets (1500)
 *   DIRECTION_COOLDOWN_HOURS    — min hours before reversing direction (24)
 *   MONOPOLIST_SHARE_BPS        — drains only when vault share >= this (8000)
 *   SSR_MIN_APY_BPS / SSR_MAX_APY_BPS — SSR sanity bounds, abort outside (100 / 1500)
 *   MAX_ALLOCATE_USDS / MAX_DEALLOCATE_USDS — REQUIRED per-cycle step caps, whole USDS
 *
 * Throws on any invalid or missing-required value. Cross-field validation:
 *   - tolerance <= margin (the HOLD zone's lower edge is SSR_t - tolerance; a tolerance
 *     above the margin would accept rates below SSR, the depositor's opportunity cost)
 *   - sleeve floor < 2000 bps (the sleeve cap is 20%; a floor at/above it is nonsensical)
 *   - SSR sanity bounds ordered (min < max)
 */
export function parseBandConfig(env: Record<string, string | undefined>): BandConfig {
  const cfg: BandConfig = {
    ssrTMarginBps: parseBps(env.SSR_T_MARGIN_BPS, 25, 'SSR_T_MARGIN_BPS'),
    ssrTToleranceBps: parseBps(env.SSR_T_TOLERANCE_BPS, 25, 'SSR_T_TOLERANCE_BPS'),
    utilDeadbandBps: parseBps(env.UTIL_DEADBAND_BPS, 50, 'UTIL_DEADBAND_BPS'),
    minBandActionUsds: parseWholeUsds(env.MIN_BAND_ACTION_USDS, 100_000n, 'MIN_BAND_ACTION_USDS'),
    sleeveFloorBps: parseBps(env.SLEEVE_FLOOR_BPS, 1500, 'SLEEVE_FLOOR_BPS'),
    directionCooldownHours: parseWholeNumber(env.DIRECTION_COOLDOWN_HOURS, 24, 'DIRECTION_COOLDOWN_HOURS'),
    monopolistShareBps: parseBps(env.MONOPOLIST_SHARE_BPS, 8000, 'MONOPOLIST_SHARE_BPS'),
    ssrMinApyBps: parseBps(env.SSR_MIN_APY_BPS, 100, 'SSR_MIN_APY_BPS'),
    ssrMaxApyBps: parseBps(env.SSR_MAX_APY_BPS, 1500, 'SSR_MAX_APY_BPS'),
    maxAllocateUsds: parseRequiredPositiveUsds(env.MAX_ALLOCATE_USDS, 'MAX_ALLOCATE_USDS'),
    maxDeallocateUsds: parseRequiredPositiveUsds(env.MAX_DEALLOCATE_USDS, 'MAX_DEALLOCATE_USDS'),
  };

  if (cfg.ssrTToleranceBps > cfg.ssrTMarginBps) {
    throw new Error(
      `SSR_T_TOLERANCE_BPS (${cfg.ssrTToleranceBps}) must be <= SSR_T_MARGIN_BPS (${cfg.ssrTMarginBps}) — ` +
      `a wider tolerance would accept rates below SSR itself`
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
