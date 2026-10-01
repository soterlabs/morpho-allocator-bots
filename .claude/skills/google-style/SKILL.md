---
name: google-style
description: Google engineering standards for TypeScript code, comments, and tests — follow for all code in this repo
---

# Google style — code, comments, tests

Distilled from primary sources: Google TypeScript Style Guide
(google.github.io/styleguide/tsguide.html), *Software Engineering at Google*
ch. 12 "Unit Testing" (abseil.io/resources/swe-book), and Google Testing Blog
"Testing on the Toilet" posts (Test Behavior Not Implementation; Test
Behaviors Not Methods; Keep Tests Focused; Tests Too DRY? Make Them DAMP;
Don't Put Logic in Tests; Writing Descriptive Test Names).

## Code

- `UpperCamelCase` types/interfaces/enums; `lowerCamelCase` functions/vars;
  `CONSTANT_CASE` only for true module-level constants. Descriptive names, no
  ambiguous abbreviations, no `_` prefixes, no `I` prefix on interfaces.
- Named exports only, never `export default`. Export only what is used
  outside the module. No `export let`.
- Prefer standalone `function` declarations over arrow-function consts for
  named functions; arrows for callbacks. `const` by default. No classes used
  purely as namespaces — use plain exported functions and constants.
- Keep functions single-purpose and small-to-medium; a function that needs
  internal section comments usually wants to be split.

## Comments

- `/** JSDoc */` documents a symbol for its users; `//` explains
  implementation for maintainers. Document every exported symbol unless the
  name + signature already say everything.
- Comments must add information the code cannot: the WHY, the invariant, the
  failure mode. Never restate the signature — omit `@param`/`@return` unless
  they add meaning beyond the type and name.
- No noise: no section banners, no comments repeating a well-named function.
- No change-narration: comments describe the code as it is now, never its
  edit history or provenance ("changed X to Y", "DECIDED <date>", "per <person>").
  History belongs to git and PR descriptions.
- Unclear literal arguments get `/* name= */` call-site comments.

## Tests

- Test **behaviors through the public API**, never implementation details.
  A pure refactor must break zero tests. Assert outputs/state, not internal
  interactions.
- **One behavior per test.** If the name needs "and", or the test calls the
  system again after an assertion, split it.
- Name = scenario + expected outcome, readable as a sentence:
  `it('holds when satAPY sits inside the SSR_t tolerance zone')` — on failure
  the name alone says what broke.
- Visible given / when / then structure (blank lines or brief comments).
- **No logic in tests**: no branches, loops, or computed expected values —
  hardcode expectations so the test is verifiable by inspection.
- **DAMP over DRY**: a little duplication is fine when it keeps each test
  self-contained. Builder helpers with sensible defaults + per-test overrides
  are good; generic `validate()` helpers that hide what is asserted are not.
- Use **realistic values** at production magnitudes (real SSR ≈ 3.52%,
  positions in the millions of USDS) so a reader develops intuition for the
  domain, plus deliberate boundary probes (exactly-at-threshold, 1 unit over).
- Prefer expressive matchers whose failure output shows expected vs actual.
- Tests should not need edits when refactoring or adding features — only when
  behavior genuinely changes.
