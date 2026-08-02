# Morpho Allocator Bots — Claude context

Allocator bots for sky.money Morpho Vault V2 vaults (see `README.md` for
addresses, roles, and per-bot setup). Each bot is a self-contained folder
deployed as its own Railway cron service.

## Skills (read before working on strategy or vault math)

- `.claude/skills/sky-economics/` — who earns what on the Flagship vault
  (Sky protocol vs sky.money vs depositor vs PT-looper), rewards campaign,
  SSR, DR. Read before changing ANY allocation target.
- `.claude/skills/allocation-strategy/` — current bot logic vs the target
  strategy (SSR-floor rate steering), Adaptive Curve IRM mechanics,
  constraints, roadmap.
- `.claude/skills/morpho-api/` — verified Morpho GraphQL recipes + gotchas
  (caps decoding, rewards vs native APY, per-adapter positions).
- `.claude/skills/google-style/` — Google engineering standards for code,
  comments, and tests. Follow for ALL code written in this repo.

## Code style (Google standards — see the google-style skill)

- Standalone small/medium pure functions; classes only when state + behavior
  genuinely belong together. Pure decision logic lives in its own module,
  separated from I/O (RPC, env, signing) so it is unit-testable without mocks.
- Comments say WHY, never WHAT or the edit history; document every exported
  symbol; no section banners; no `@param` boilerplate that restates types.

## Tests (Google style)

- Test behaviors through the public API, one behavior per test, named as
  scenario + expected outcome. Given/when/then structure, no logic in test
  bodies, DAMP over DRY (builder helpers with overrides are fine).
- Use realistic production-scale values (SSR ≈ 3.52%, positions in millions
  of USDS) plus exact boundary probes, so tests double as domain examples.

## Ground rules

- All timestamps UTC.
- Never commit secrets; signing keys live as sealed Railway variables.
- Test against a Tenderly fork before mainnet; deploys to the production
  Railway services require Soter-side approval.
- Fail loud: no silent try/catch, no defaulted env vars that mask
  misconfiguration (the bps-sum startup throw is the model to follow).
