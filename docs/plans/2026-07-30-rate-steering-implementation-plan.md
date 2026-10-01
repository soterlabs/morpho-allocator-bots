# Flagship rate-steering allocator — implementation plan

Date: 2026-07-30. Status: **proposal for Jan/Kacper review**.
Produced from a 9-agent design workflow (3× codebase recon, 3 competing designs,
backtest design, adversarial judge, completeness critic) on top of the
2026-07-30 product mandate (see `.claude/skills/allocation-strategy/`).

## 0. TL;DR

Build **on top of Kuba's `feature/allocation-optimizer` branch**, not from
scratch. Ship a minimal-diff **utilization-band controller** ("Bandsteer"):
the existing executor, Safe machinery, and liquidity math stay byte-for-byte;
we swap exactly one seam — the function that produces per-market target
*amounts*. Bands are parameterized as **fractions of SSR** (Jan's correction:
LOW = 4/7·SSR, HIGH = 8/7·SSR), SSR is read **on-chain from `sUSDS.ssr()`**
in the same pinned block (no DeFiLlama dependency in the live path). PT-sUSDS
runs in a new **SOUNDING mode** (top-down demand discovery, Kacper's "wrzucamy
3M i patrzymy czy chwyci"). Cadence goes 6h → **20 min** with strict internal
deadbands. Five PRs, each independently reviewable by Soter; shadow mode for
1–2 weeks and a backtest with quantitative GO/NO-GO gates before any mainnet
canary.

> **2026-07-30 evening: all 15 open questions decided by Jan — see section 8.**

## 1. Decision: build on Kuba's branch — verified, not assumed

Recon confirmed the branch already contains most of the hard machinery, tested:

| existing asset | role in the new bot |
|---|---|
| `computeAllocationActions` amounts-mode (`allocation-logic.ts:219`) | already accepts per-market target AMOUNTS overriding bps — our injection point |
| `maxWithdrawableForUtilization` (`allocation-logic.ts:188`) | the exact "drain down to utilization X" primitive the bands need |
| `capDeallocationsToLiquidity` with per-market `maxUtilizationBps` | generic, tested (WETH uses it today) — band util plugs straight in |
| `sdkRateModel` (`optimizer-logic.ts:51-94`) | exact post-trade util/rate via blue-sdk — the layer-0 prediction, done |
| `computeReachableFloors`, `computeEffectiveMarketCap`, budget/cap clamps | multi-cycle drains, PT $5M cap, aggregate 20% cap — done |
| Safe MultiSend batch, deallocate-before-allocate, gas buffer | execution — untouched |
| 1,300-line vitest suite over the pure layer | extended, not replaced |
| greedy `optimizeAllocations` (marginal Δ(x·r(x))) | Phase B: init `bestGainPerUnit` to SSR_t instead of 0 — a one-line documented seam |

Starting fresh would rewrite all of the above and multiply Soter's review
burden for zero strategic gain. The greedy CLI stays as a read-only companion
(re-pointed at band logic in Phase B, or retired — open question #15).

## 2. The design: Bandsteer (winner of a 3-design adversarial bake-off)

Two competing designs lost but donated parts: a per-market state machine
("Helmsman" — its guard architecture is grafted wholesale) and policy-as-data
("RULEBOOK" — its config-hash + auto-rendered rulebook doc are grafted).

### 2.1 One-seam swap

`allocator.ts` calls `computeEffectiveTargetAmounts` at `:525` and `:631` to
turn static bps into amounts. Bandsteer replaces those two call sites with a
new pure module `band-controller.ts`. Everything downstream (threshold gate,
liquidity caps, aggregate-cap budget, atomic Safe batch) consumes the amounts
unchanged. Net executor diff: **~90 added / 25 removed lines**.

### 2.2 Bands — SSR-proportional (integer fractions, deterministic)

Read in the pinned block: `susds.ssr()` (per-second RAY → APY), each market's
`rateAtTarget` (anchor) and accrued `supplyApy`. Derive
`LOW = (4/7)·SSR ≈ 2.0%`, `HIGH = (8/7)·SSR ≈ 4.0%`, `SSR_t = SSR + 15 bps`
(configurable 10–20, per-market override for the PT-vs-bluechip question).

| condition (precedence order) | hold utilization | meaning |
|---|---|---|
| supply@target ≥ SSR_t | **90%** | harvest / neutral — market pays its keep |
| supplyApy < LOW | **94%** | drain hard, fastest useful anchor drift |
| supplyApy > HIGH ∧ anchor < SSR_t | **92%** | close to goal, gentle pressure |
| otherwise | **93%** | mid band |

Target amount = `ceil(borrow × 10000 / bandUtilBps)` on accrued totals; the
band util also becomes that market's dynamic `maxUtilizationBps`, so the
already-tested withdrawal clamps land drains exactly on band.

Note one deliberate deviation to ratify: harvest triggers on
**supply@target ≥ SSR_t** (= anchor ≥ SSR_t/0.9), not Kacper's literal
"anchor ≥ SSR_t". It is the economically correct form (realized supply yield
at 90% util actually meets the target); both conditions are logged every
cycle so shadow data can settle it (question #3).

### 2.3 SOUNDING mode (proposed name for "early-stage markets")

*Nautical depth-sounding: throw the lead line to measure how deep demand
runs.* Exactly Kacper's top-down discovery, no DR in the objective.

- **Entry**: config only (`MODE_PTSUSDS=SOUNDING`) — never automatic.
- **Feed rule**: feed `min(tranche, capHeadroom)` iff (a) util ≥ 95% — the
  previous tranche *stuck*; (b) ≥ 24h since the last completed feed (from
  on-chain events); (c) headroom under min(PT $5M, on-chain caps, aggregate
  budget). Tranche ladder: **$3M first, $1.5M follow-ups** (bounds anchor
  damage of a later unabsorbed tranche).
- **A tranche that doesn't stick halts feeding automatically** (condition (a)
  fails). No auto-drain of a sounding market — draining defeats discovery;
  exposure is capped at $5M.
- **Graduation** (memoryless, no lifecycle state): supply@target ≥ SSR →
  market flips to STEERED rules. Demand discovery succeeded.
- **Reality check**: the adapter cap is full and bluechip unborrowed
  liquidity is ~$0.36M today, so "throw in $3M" physically realizes as a
  multi-day drip funded by same-batch bluechip drains (deallocate-first
  ordering makes this emergent, not special-cased). Kacper should confirm
  this expectation (question #9).
- **PT maturity 26 Nov 2026** — three-stage ladder: T-30d allocation
  forbidden; T-14d forced drain band; T-0 target 0 + sweep + per-cycle WARN.
  Maturity is hardcoded in `market-config.ts` with a fail-loud check.

Market modes: `STEERED` (cbBTC, wstETH, WETH — "może zostać dopóki zarabia"),
`SOUNDING` (PT-sUSDS), `RETIRED` (stUSDS — risk-quarantined, never allocate).
`WINDDOWN` is computed from maturity, not configured.

### 2.4 Guards (grafted from the losing designs — best-in-class set)

- **A/B bracket, both scenarios**: before any steering action, project 24h
  ahead under A (no borrower reaction) and B (instant re-equilibration to 90%
  util); act only if BOTH land inside bounds (e.g. borrow ≤ 3×SSR). Instead
  of a binary veto, a deterministic step-shrink grid {1, ½, ¼, 0} — partial
  progress beats a full hold. SOUNDING feeds bypass the bracket by explicit
  product decision (the anchor-decay cost of a big feed is the accepted price
  of discovery) but the projection is logged.
- **Hysteresis**: util deadband 50 bps; min steering action **$30k flat**
  (decided; the 100 USDS dust floor remains only for retired-market sweeps);
  per-market **24h direction-change cooldown** reconstructed
  deterministically from Morpho Blue Supply/Withdraw events
  (`onBehalf = adapter`, cross-checked against the Safe's ExecutionSuccess to
  ignore third-party `forceDeallocate`) — **the chain is the state store, no
  new infrastructure, every decision reproducible from a block number**.
- **Monitors** (WARN in shadow, veto at canary): borrow > 3×SSR persisting;
  util pinned 100% with zero Repay events (exempt: SOUNDING); reality outside
  the previous cycle's A–B bracket; monopolist-share < 80% → go neutral (stop
  fighting an external supplier); RAISE_CAP_SIGNAL when a capped market
  sustains rate ≫ SSR_t.
- **Ops guards** (PR1, ship first): failed tx → exit 1 (today's executor
  swallows execution errors and exits 0 — must fix before any cadence
  increase), receipt timeout 5min (the usdt-savings fix, never ported),
  pending-nonce guard, `BOT_PAUSED` kill-switch env, EOA gas-balance floor,
  Slack webhook alerting + dead-man heartbeat (Railway doesn't alert on
  skipped crons).

### 2.5 Determinism & the regulatory story

Pure decision core; all reads pinned to one block; no mutable state files;
cross-run state from chain events. Every cycle emits a JSON **decision trace**
with named rule IDs (R-HARV, R-DRAIN, R-SND, R-WD1…), the resolved absolute
thresholds (so traces stay legible at any SSR), both harvest conditions, the
A/B projections, and a **sha256 of the parsed config**. `npm run config:doc`
renders the validated config into a human-readable rulebook markdown with a
CI staleness check — the "clear, automated allocation" artifact for the
securities-law angle. Decision traces need a durable sink (proposed:
ClickHouse table via the existing analytics pipeline — punch list).

### 2.6 Cadence

`railway.toml` cron `*/20 * * * *` (decided: 20-minute evaluation, 72
runs/day). Railway skips a slot while the previous run lives = platform-level
overlap protection; PR1's nonce/receipt fixes make that safe. Evaluation ≠
action: deadband + $30k min action + 24h direction cooldown mean most ticks
are no-ops, so dust churn ("$3 co 5 minut") stays impossible by construction.
Operational consequence: a **dedicated RPC endpoint is mandatory** (each run
does a getLogs window + ~20 reads; 72×/day is untenable on public RPCs).

### 2.7 Config (fail-loud, replaces the bps-sum invariant)

`ALLOCATION_MODE = bps | bands` — required, no default; `bps` is bit-for-bit
today's behavior (safe rollback). `validateBandConfig` throws at startup on:
band monotonicity (94 ≥ 93 ≥ 92 ≥ 90), LOW < HIGH, cooldowns ≤ event-lookback
window, SSR sanity bounds, missing step caps (`MAX_ALLOCATE_USDS` /
`MAX_DEALLOCATE_USDS` required in bands mode), unknown mode values. SSR
outside [1%, 15%] → abort cycle, never default. **Sleeve floor (decided):
`SLEEVE_FLOOR_BPS = 1200`** — when band drains would push total allocated
below 12% of TVL, drains are scaled back proportionally (floor beats bands). Market `fee == 0` asserted
every cycle (all thresholds assume it). `RPC_URL` becomes required (no more
public-RPC default; hourly runs with getLogs need a dedicated endpoint).

## 3. Phase B (after Phase A is stable)

Growth inside harvest-band markets via Kuba's greedy with the SSR_t floor:
initialize `bestGainPerUnit` at `optimizer-logic.ts:184` to the SSR_t
per-second rate instead of 0 — the greedy then stops exactly when the
marginal dollar earns less than SSR_t, and average rates settle *above*
target (the marginal-revenue logic Jan identified). Feed per-market band
utils into `withUtilizationCeiling`. This is a documented one-line seam; no
architectural work needed now.

## 4. PR breakdown & rollout

| PR | content | Soter reviews | risk |
|---|---|---|---|
| **PR1** | fail-loud execution hygiene: rethrow tx errors/exit 1, receipt timeout, pending-nonce guard, required RPC_URL, pinned snapshot reads, Slack alerting | error paths only; success behavior provably identical | ships to prod immediately at 6h — de-risks everything after |
| **PR2** | pure band logic + tests: `band-config.ts`, `band-controller.ts`, `anchor-sim.ts`, `onchain-history.ts`, `sweepByIndex` decoupling (retired-sweep no longer keyed on bps==0) | math vs the mandate doc; executor untouched | zero production risk (new files) |
| **PR3** | the seam: `ALLOCATION_MODE` switch wiring band targets into `targetPerMarketAmountsByIndex` + dynamic `maxUtilizationBps` | one seam, 2 call sites, ~90/-25 lines | `bps` mode byte-identical = instant rollback |
| **PR4** | shadow + cadence: second Railway service in DRY_RUN bands mode at 1h, live bot untouched; shadow report tooling | config only | none |
| **PR5** | cutover: live service to bands @1h after shadow gates pass; remove mode switch later | GO/NO-GO evidence pack | canary step caps active |

Timeline estimate: PR1 days 1–2 · PR2 ~1 week · PR3 ~3 days · shadow 1–2
weeks · cutover ≈ **week 4–5**. Commits co-authored (Jan + Claude).

## 5. Backtesting harness (`tools/band-sim/`)

- **Single source of math**: `anchor-sim.ts` wraps blue-sdk's
  `AdaptiveCurveIrmLib` (pure bigint, verified bit-exact vs the on-chain
  formulas; npm ci'd and read during recon). The SAME function runs in the
  live bot's projections and the simulator. Pitfall found by recon: `wExp` is
  a chunked Taylor approximation → drift is segmentation-dependent; the sim
  must use explicit segmentation, property-tested vs `Market.accrueInterest`
  (≥10k random segments, zero tolerance).
- **Snapshot as the interface**: harness reads one schema-versioned JSON file
  (daily per-market state since vault launch 2026-01-21) checked into the
  repo; an exporter script produces it from ClickHouse
  `morpho_api.market_state_daily` + Morpho GraphQL + on-chain — CI and
  reviewers need no credentials.
- **Borrower model**: threshold-band partial adjustment — borrowers defend a
  carry band [rMin, rMax]; above rMax they repay at speed κ·(over-rate),
  below rMin they lever up. rMax is independently checkable (PT ≈ fixed
  yield 3.6–4%; wstETH ≈ staking yield; cbBTC ≈ basis). The A/B bracket is
  literally this model's κ→0 / κ→∞ limits — one family spans point estimate
  and safety envelope.
- **Calibration episodes** (verified in data): E1 WETH drain + recovery
  (Mar–May), E2 wstETH trim (07-29: 2.3%→3.3% next day), E3 stUSDS exit
  (May–Jun: borrowers repaid ~1:1 with the drain). Daily data can't resolve
  same-day repayment speed → export raw Morpho events for episode windows.
- **Metrics vs baselines**: realized sleeve APY and % of market-days inside
  [SSR_t − 25bps, +50bps], vs (a) the incumbent static bot's *actual*
  realized history (zero model risk) and (b) do-nothing.

## 6. Tenderly — what it is and how we use it (plain words)

Tenderly lets us spin up a **private fork of Ethereum mainnet** — an exact
copy of all contracts and state at a chosen block, on our own RPC URL, where
transactions cost nothing and touch nothing real. Three properties we use:

1. **Impersonation** — the fork lets us send transactions *as* the Safe
   without its keys, so the real bot code executes its real batch against
   real Morpho contracts (catches revert paths: RelativeCapExceeded, GS013,
   liquidity clamps).
2. **Time travel** — `evm_increaseTime` fast-forwards days in seconds, so we
   watch the *actual on-chain IRM* drift anchors in response to our drains
   and verify `anchor-sim` against the deployed contract (borrowRateView
   grid over util × anchor × dt), not just against the SDK.
3. **Disposable** — CI spawns a fresh fork per test run via API (Virtual
   TestNets), runs the bot end-to-end, throws the fork away.

What a fork can NOT test: borrowers. Nobody repays on a dead copy — that's
what the backtest's borrower model and the shadow phase are for. Pyramid:
unit (math) → backtest (strategy) → Tenderly (execution) → shadow (live
reality, zero risk) → canary (live, step-capped).

## 7. Acceptance gates (GO/NO-GO before canary — proposed, need sign-off)

1. `anchor-sim` bit-exact vs SDK (zero tolerance) and vs the deployed IRM on
   a Tenderly fork.
2. Replay fidelity: simulating the *actual* historical policy reproduces
   reality (utilization error bounds per market).
3. Backtest: band-steering ≥ **+20 bps** (decided; softened from the
   proposed +40) realized sleeve APY vs the static baseline, net of gas,
   across the elasticity sweep (κ=0 worst case must not *lose* vs static).
4. ≤ 2 direction flips per market-week in backtest and shadow.
5. Shadow: ≥ 95% of cycles' realized state inside the previous cycle's A–B
   bracket; zero unexplained vetoes; decision traces grade clean.
6. Ops: Railway alerting + dead-man heartbeat tested; pause/unpause drill.

## 8. DECISIONS (Jan, 2026-07-30 evening — all 15 questions closed)

| # | question | decision |
|---|---|---|
| 1 | SSR_t margin | **SSR + 15 bps, ±5 bps deadband**; tune in shadow |
| 2 | PT vs bluechip SSR_t | **single SSR_t in Phase A**; per-market override stays in config |
| 3 | harvest trigger | **`supply@target ≥ SSR_t`** (corrected form); both conditions logged every cycle |
| 4 | SSR-proportional thresholds | **ratified: LOW = 4/7·SSR, HIGH = 8/7·SSR** (Jan's own proposal); resolved absolutes logged |
| 5 | sleeve floor | **hard floor 12% of TVL** (`SLEEVE_FLOOR_BPS=1200`); drains scale back proportionally at the floor |
| 6 | cadence | **fixed cron every 20 min** (`*/20 * * * *`); internal gates decide action; dedicated RPC required |
| 7 | min steering action | **$30k flat**; 100 USDS dust floor only for retired sweeps |
| 8 | WETH | **full band participant** — can grow again when it defends SSR_t |
| 9 | sounding tranches | **$3M first / $1.5M follow-ups**, stick-gate util ≥ 95%, cooldown keyed on tranche completion; multi-day drip mechanics accepted |
| 10 | pause authority | **as today** — Railway env control stays with existing ops (Soter/Kacper side); Jan does not hold pause |
| 11 | alert routing | **dedicated Slack channel** via Railway webhook secret |
| 12 | monopolist threshold | default adopted: **80%** vault share → below it, neutral mode |
| 13 | RW/DR decoupling | default adopted: **objective ignores both**; logged as per-cycle context |
| 14 | GO/NO-GO gates | adopted with **backtest edge softened to +20 bps** vs static (was +40) |
| 15 | after PT maturity 26 Nov | **decide then** — the T-30/T-14 ladder forces the wind-down regardless; freed capital lands in bands mechanically; new PT series would need an explicit config PR |

## 9. Punch list (real gaps found by the critic — folded into PRs)

- Executor swallows tx failures & exits 0 → **PR1** (this is why PR1 ships
  first).
- No pre-flight `eth_call` simulation of the batch → add to PR3 (band drains
  run tighter margins than today's 5% cushion).
- Gas economics: fee cap, EOA balance floor, gas netted in backtest → PR1/PR5.
- Decision-trace durable sink (ClickHouse) + hourly observation schema shared
  bot↔harness → PR4.
- Ex-post bracket monitor must exist in WARN mode *before* shadow, not after
  → PR2.
- Pin blue-sdk exact version (caret range can silently change math) → PR2.
- Borrow-side rewards campaigns (Merkl/MORPHO) shift borrower carry
  invisibly → campaign-change monitor on the 4 markets → PR4.
- Signer ops runbook (key rotation, compromise blast radius, distinct EOAs
  per bot) → docs, pre-canary.
- Event-ledger attribution: filter by caller/Safe ExecutionSuccess so
  third-party `forceDeallocate` can't pollute cooldowns → PR2 (already in
  design).
