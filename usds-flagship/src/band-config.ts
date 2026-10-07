/**
 * Band-steering configuration for the Flagship Vault Allocator Bot.
 *
 * In bands mode (ALLOCATION_MODE=bands) each STEERED market is held at the
 * utilization where its current borrow rate equals the on-chain Sky Savings Rate
 * plus a margin (see band-controller.ts). This module owns:
 *
 *   - the BandConfig shape and its env parsing/validation (parseBandConfig),
 *   - the retired-knob scan (retiredBandEnvWarnings) for env left over from the
 *     satAPY ladder this steering replaced,
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
 *   STEERED  — steered to the utilization where its borrow rate meets SSR + margin.
 *   PRIMARY  — no rate target: asks for deposits up to its cap, but never past the
 *              point where its own utilization would drop under
 *              PRIMARY_MIN_UTIL_PERCENT; served before any other deposit (at most
 *              one market; see band-controller.ts).
 *   SOUNDING — reserved; configuring it refuses to start (see parseMarketMode).
 *   RETIRED  — the bot never touches the market.
 */
export type MarketMode = 'STEERED' | 'PRIMARY' | 'SOUNDING' | 'RETIRED';

export interface BandConfig {
  rateMarginBps: number;       // target borrow rate = SSR + margin (per-market override in MarketConfig)
  utilMinBps: number;          // the target utilization is clamped into [utilMinBps, utilMaxBps]
  utilMaxBps: number;
  primaryMinUtilPercent: number; // a PRIMARY fill never pushes that market's utilization under this
  utilDeadbandBps: number;     // no action within +-deadband of the target utilization
  minBandActionUsds: bigint;   // smaller steering legs and priority deposits are dropped
  minPriorityWithdrawalUsds: bigint; // smaller priority withdrawals (cap breaches) wait
  sleeveFloorBps: number;      // hard floor on the allocated sleeve, bps of totalAssets
  directionCooldownHours: number;
  monopolistShareBps: number;  // drains allowed only at/above this vault share
  ssrMinApyBps: number;        // SSR sanity bounds — abort the cycle outside them
  ssrMaxApyBps: number;
  maxAllocateUsds: bigint;     // REQUIRED per-cycle step caps
  maxDeallocateUsds: bigint;
}

const USDS_WAD = 10n ** 18n; // USDS has 18 decimals

/**
 * Env vars of the retired satAPY ladder (SSR_t margin / tolerance zone). They are
 * ignored: the rate target replaced the zone outright and the margin changed meaning
 * (it now sits on the borrow rate, not on a 0.9 x anchor proxy), so an old value
 * must never be reinterpreted as a new one. Left in place on a deployment they only
 * earn a startup warning — a bands-mode cutover ships with zero env changes.
 */
export const RETIRED_BAND_ENV_VARS: readonly string[] = [
  'SSR_T_MARGIN_BPS', 'SSR_T_TOLERANCE_BPS',
  'SSR_T_MARGIN_STUSDS_BPS', 'SSR_T_MARGIN_CBBTC_BPS', 'SSR_T_MARGIN_WSTETH_BPS',
  'SSR_T_MARGIN_PTSUSDS_BPS', 'SSR_T_MARGIN_WETH_BPS',
];
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
 * Parse a whole-number percent env in [1, 100]. Returns the default ONLY when unset;
 * 0 is rejected (it would divide by zero in the utilization floor it configures).
 */
function parsePercent(raw: string | undefined, defaultValue: number, label: string): number {
  const value = parseWholeNumber(raw, defaultValue, label);
  if (value < 1 || value > 100) {
    throw new Error(`${label} must be a whole number of percent in [1, 100], got "${raw}"`);
  }
  return value;
}

/**
 * Parse and validate the full band-steering configuration from an env record.
 *
 * Env vars and defaults:
 *   RATE_MARGIN_BPS             — target borrow rate = SSR + margin (60); a per-market
 *                                 RATE_MARGIN_<MARKET>_BPS override is parsed with the
 *                                 market table (market-config.ts)
 *   UTIL_MIN_BPS / UTIL_MAX_BPS — the target utilization is clamped into this range
 *                                 (8000 / 9500): below 80% a market is pure dilution,
 *                                 above 95% its idle liquidity is too thin to drain
 *   PRIMARY_MIN_UTIL_PERCENT    — a PRIMARY fill stops where that market's utilization
 *                                 would drop under this (86), so it tracks its own
 *                                 borrow demand instead of absorbing every freed dollar
 *   UTIL_DEADBAND_BPS           — no action within +-deadband of the target utilization (50)
 *   MIN_BAND_ACTION_USDS        — smaller steering legs / priority deposits are dropped, whole USDS (10000)
 *   MIN_PRIORITY_WITHDRAWAL_USDS — smaller priority withdrawals (cap breaches) wait, whole USDS (50000)
 *   SLEEVE_FLOOR_BPS            — hard sleeve floor as bps of totalAssets (1500)
 *   DIRECTION_COOLDOWN_HOURS    — min hours before reversing direction (24)
 *   MONOPOLIST_SHARE_BPS        — drains only when vault share >= this (8000)
 *   SSR_MIN_APY_BPS / SSR_MAX_APY_BPS — SSR sanity bounds, abort outside (100 / 1500)
 *   MAX_ALLOCATE_USDS / MAX_DEALLOCATE_USDS — REQUIRED per-cycle step caps, whole USDS
 *
 * Throws on any invalid or missing-required value. Cross-field validation:
 *   - 0 < UTIL_MIN_BPS < UTIL_MAX_BPS (a zero floor would divide by zero in the
 *     target inversion; an inverted range has no target at all)
 *   - step caps >= MIN_BAND_ACTION_USDS, MAX_DEALLOCATE_USDS >= MIN_PRIORITY_WITHDRAWAL_USDS
 *     (a step cap under a drop threshold would clamp every wish into the drop)
 *   - sleeve floor < 2000 bps (the sleeve cap is 20%; a floor at/above it is nonsensical)
 *   - SSR sanity bounds ordered (min < max)
 */
export function parseBandConfig(env: Record<string, string | undefined>): BandConfig {
  const cfg: BandConfig = {
    rateMarginBps: parseBps(env.RATE_MARGIN_BPS, 60, 'RATE_MARGIN_BPS'),
    utilMinBps: parseBps(env.UTIL_MIN_BPS, 8000, 'UTIL_MIN_BPS'),
    utilMaxBps: parseBps(env.UTIL_MAX_BPS, 9500, 'UTIL_MAX_BPS'),
    primaryMinUtilPercent: parsePercent(env.PRIMARY_MIN_UTIL_PERCENT, 86, 'PRIMARY_MIN_UTIL_PERCENT'),
    utilDeadbandBps: parseBps(env.UTIL_DEADBAND_BPS, 50, 'UTIL_DEADBAND_BPS'),
    minBandActionUsds: parseWholeUsds(env.MIN_BAND_ACTION_USDS, 10_000n, 'MIN_BAND_ACTION_USDS'),
    minPriorityWithdrawalUsds: parseWholeUsds(env.MIN_PRIORITY_WITHDRAWAL_USDS, 50_000n, 'MIN_PRIORITY_WITHDRAWAL_USDS'),
    sleeveFloorBps: parseBps(env.SLEEVE_FLOOR_BPS, 1500, 'SLEEVE_FLOOR_BPS'),
    directionCooldownHours: parseWholeNumber(env.DIRECTION_COOLDOWN_HOURS, 24, 'DIRECTION_COOLDOWN_HOURS'),
    monopolistShareBps: parseBps(env.MONOPOLIST_SHARE_BPS, 8000, 'MONOPOLIST_SHARE_BPS'),
    ssrMinApyBps: parseBps(env.SSR_MIN_APY_BPS, 100, 'SSR_MIN_APY_BPS'),
    ssrMaxApyBps: parseBps(env.SSR_MAX_APY_BPS, 1500, 'SSR_MAX_APY_BPS'),
    maxAllocateUsds: parseRequiredPositiveUsds(env.MAX_ALLOCATE_USDS, 'MAX_ALLOCATE_USDS'),
    maxDeallocateUsds: parseRequiredPositiveUsds(env.MAX_DEALLOCATE_USDS, 'MAX_DEALLOCATE_USDS'),
  };

  if (cfg.utilMinBps < 1 || cfg.utilMinBps >= cfg.utilMaxBps) {
    throw new Error(
      `utilization clamp must satisfy 0 < UTIL_MIN_BPS < UTIL_MAX_BPS, got ` +
      `UTIL_MIN_BPS ${cfg.utilMinBps}, UTIL_MAX_BPS ${cfg.utilMaxBps}`
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
  if (cfg.maxAllocateUsds < cfg.minBandActionUsds || cfg.maxDeallocateUsds < cfg.minBandActionUsds) {
    throw new Error(
      `MAX_ALLOCATE_USDS and MAX_DEALLOCATE_USDS must be >= MIN_BAND_ACTION_USDS ` +
      `(${cfg.minBandActionUsds / USDS_WAD} USDS) — a step cap below the min action would clamp ` +
      `every wish under the drop threshold and the bot could never move funds`
    );
  }
  if (cfg.maxDeallocateUsds < cfg.minPriorityWithdrawalUsds) {
    throw new Error(
      `MAX_DEALLOCATE_USDS must be >= MIN_PRIORITY_WITHDRAWAL_USDS ` +
      `(${cfg.minPriorityWithdrawalUsds / USDS_WAD} USDS) — a step cap below it would clamp ` +
      `every priority withdrawal under its drop threshold and a cap breach could never be drained`
    );
  }

  return cfg;
}

/**
 * One warning line per retired band env var that is still set, for the executor to
 * log at startup. Pure: the caller decides how to surface them. The values are not
 * parsed at all — a retired knob is ignored whatever it holds.
 */
export function retiredBandEnvWarnings(env: Record<string, string | undefined>): string[] {
  return RETIRED_BAND_ENV_VARS
    .filter(name => env[name] !== undefined)
    .map(name => `${name} is set but retired — ignored (rate-target steering uses RATE_MARGIN_BPS / RATE_MARGIN_<MARKET>_BPS)`);
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
 * Every rate target is SSR + margin, so a corrupted read (proxy upgrade, ABI drift,
 * RPC garbage) would silently re-aim every market — better to throw and skip the
 * cycle than steer the sleeve off a bogus anchor. NaN/Infinity also throw.
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
