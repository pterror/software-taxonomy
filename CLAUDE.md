# software-taxonomy

## Origin

A cladistic taxonomy of software as living organisms — started as a conversation, became a corpus. The key insight: software evolves like biology (forks, merges, convergent solutions, extinct lineages), and cladistics (not Linnaean ranks) fits it best. Phase 1 inverted the original schema: the primary artifact is a **general knowledge graph**; taxonomy is a derived view over `subclass_of`.

The repo is a standalone public corpus at https://github.com/pterror/software-taxonomy.

## Model

The data lives in `data/`:
- `data/entities/<ns>/<slug>.json` — one entity per file. `<ns>` is the id namespace (`software`, `class`, `org`, etc.). The file contains the entity id, optional metadata (labels, aliases, description), and a `statements` array.
- `data/predicates/<predicate-file>.json` — one predicate definition per file.
- `data/sources/<kind>.jsonl` — source records grouped by kind (e.g. `wikipedia.jsonl`, `official.jsonl`). One record per line.
- `data/lenses/<lens-id>.json` — lens identity, register (`factual` | `interpretive` | `fictional` | `folkloric`), dependencies, `source_required` flag.

Each statement is a flat object in the entity's `statements` array:

```jsonc
{
  "id": "s:abc1234",
  "predicate": "@core:instance_of",
  "value": "@class:word-processor",
  "lens": "@core",
  "rank": "preferred",
  "sources": [{"id": "wp:Microsoft_Word@1234567", "snippet": "..."}]
}
```

The `snippet` field is the anti-confabulation primitive: every sourced statement must include the verbatim excerpt from the source that supports the claim. `bun run snippet-todo` surfaces statements with sources but no snippet. `bun run verify-snippets` checks that snippets are non-empty.

A clade is an entity with `instance_of @meta:class`. The class hierarchy is `subclass_of` chains. Programs are `instance_of @some-class`. Everything else (people, orgs, features) is typed by their own `instance_of` statements.

## Id namespace convention

All entity ids use namespaced form: `<type>:<slug>`. No bare ids.

| Namespace | Used for | Example |
|-----------|----------|---------|
| `meta` | The class-of-classes | `@meta:class` |
| `class` | All class entities (any lens) | `@class:software`, `@class:documenta` |
| `software` | Executable programs | `@software:microsoft-word` |
| `format` | Data file formats | `@format:docx`, `@format:json` |
| `protocol` | Communication protocols | `@protocol:http` |
| `specification` | Technical specs/standards | `@specification:posix` |
| `os` | Operating systems | `@os:windows`, `@os:linux` |
| `language` | Programming languages | `@language:rust`, `@language:python` |
| `license` | Software licenses | `@license:mit`, `@license:gpl-v3` |
| `org` | Organizations and companies | `@org:microsoft`, `@org:apache-software-foundation` |
| `person` | Human individuals | `@person:linus-torvalds` |
| `collective` | Community-driven groups | `@collective:linux-kernel-community` |
| `daimon` | Mythology-demo instances | `@daimon:of-sendmail` |

Third-party imports will use source-specific prefixes: `@wd:<id>` for Wikidata, etc.

The biology lens's kingdoms (`@class:documenta`, `@class:oracula`, etc.) use the `class:` namespace despite being biology-owned — namespace indicates type, not ownership.

## Supertype class hierarchy

```
@meta:class
  @class:technical-artifact    ← software, file-format, protocol, specification
    @class:software             ← operating-system, programming-language, word-processor, ...
  @class:agent                 ← organization, person, collective
  @class:license
```

## Unknown/novalue sentinels

When a value is unknown or inapplicable, use sentinel objects instead of omitting the statement:

- `{"unknown": true}` — "we know this property applies but the value is unknown" (Wikidata `somevalue`)
- `{"novalue": true}` — "we know this property does not apply" (Wikidata `novalue`)

Sentinels count toward **MAX** cardinality but **NOT MIN**. A `1..1` required predicate with only `{"unknown": true}` is a cardinality error ("0 real values found, 1 required"). Sentinels assert presence, not content — use them for "known unknown" gaps, not to satisfy required fields.

## Conventions

- Entity ids: namespaced form `<type>:<slug>`, pattern `^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$` — exactly one colon, non-empty parts on each side. No bare ids, no double colons.
- Predicate ids: snake_case, `^[a-z][a-z0-9_]*$`.
- Entity refs in statement values: `@<namespace>:<slug>` prefix.
- Source ids in statements: must exist in `data/sources/` (any `.jsonl` file therein).
- Every factual claim needs a `source`. Class structure (synapomorphies, etymologies, rank hints) is intrinsic; structural predicates (`instance_of`, `subclass_of`) on class entities are exempt.
- One record per line in all `.jsonl` files. Recompact with `jq -c`.
- `instance_of` with `rank: "preferred"` disambiguates the primary class when multiple are present. **At most one** `instance_of` may be `preferred` — the validator errors on `multi-preferred-instance-of`.

## Class curation rule

Classes are pre-curated by humans, never auto-invented during ingest. An ingest tool that encounters an instance not fitting an existing class proposes the new class for review rather than creating it automatically. The substrate-pre-seed pattern from Phase 3.0 is the general rule, not just a Phase-3 thing.

New class checklist:
1. Does the candidate differ meaningfully from existing classes (synapomorphy, not just label)?
2. Are there at least 3 known instances to justify a new class?
3. Does it fit cleanly under an existing superclass?

## Predicate vocab governance

- **To add a predicate**: open a PR adding a JSON file under `data/predicates/` with full `value_type`, `domain`, `range`, `cardinality` constraints, and a `lens` field. Consider whether an inverse is needed.
- **To deprecate a predicate**: set `deprecated: true` and document the successor in the predicate's `description`. The validator will warn on all uses.
- **To merge near-duplicates**: set `alias_of` on the deprecated predicate pointing to the canonical. The validator resolves constraints from the canonical and logs an info message on use.
- **`expect_preferred` flag**: set `expect_preferred: false` on predicates where multiple parallel current values are the norm and designating a "primary" would be wrong (e.g. `written_in`, `runs_on`, `licensed_under`, `principal_author`, `synapomorphy`, `aspect_of`). The `no-preferred-rank` validator warning is suppressed for predicates with this flag. Default is `true`.

## Validation architecture

`bun run validate` loads the full corpus into an in-process EAV TripleStore (`@thi.ng/rstream-query`) and runs all rules in a single TypeScript process — no subprocess, no external schema layer.

**Loader** (`tooling/src/lib/load.ts`) — reads `data/` and transacts all entities, predicates, sources, and lenses into a fresh `Db`. Tracks `:statement/file` and `:statement/line` for error provenance.

**Rules** (`tooling/src/lib/rules.ts`) — each rule is a TypeScript function over the `Db`. Rules use `q()` for basic joins; post-process in TS for recursion (fixpoint), negation-as-failure, and aggregation. Rule categories:
- `duplicate_entity_id`, `dangling_entity_ref`, `dangling_source_ref`
- `domain_violation`, `range_violation`
- `cardinality_violation_min`, `cardinality_violation_max`
- `multi_preferred`, `no_preferred_rank`
- `deprecated_no_end_time`, `end_without_start`
- `source_required_violation`, `cross_lens_fictional`
- `qualifier_unknown_predicate`, `qualifier_dangling_ref`
- `alias_self_reference`, `alias_cycle`, `alias_chain_too_long`

**Alias constraint cascade:** `alias_of` predicates inherit domain, range, cardinality, and `expect_preferred` from their canonical predicate. All constraint checks consult the effective (canonical) predicate definition.

**Source-required per-statement:** each statement is checked independently. A sourced sibling at the same rank does NOT exempt an unsourced one.

**To add a new rule:** write a function in `tooling/src/lib/rules.ts` that accepts a `Db` and returns `Violation[]`. Register it in `runAllRules`.

**Regression fixtures:** `tooling/test/fixtures/`. Each fixture is a minimal `data/`-style directory + `expected.json`. Run: `bun run test-fixtures`.

**Fixture conventions:**
- `expected.json` is an array of `{ rule, entityId?, predicateId?, severity?, count? }` objects.
- All rules are checked: both MISSING expected and UNEXPECTED actual violations fail the fixture.
- `count` (default 1): specifying explicitly enforces multiplicity. Useful for catching regressions like source_required silently skipping a statement.
- `transitive-subclass-3hop` and other "clean" fixtures use `expected.json: []` to assert zero violations.

## Validator warnings reference

| Rule | Severity | Meaning |
|------|----------|---------|
| `deprecated-no-end-time` | warning | A `rank: deprecated` statement has no `end_time` qualifier — historical claim is open-ended |
| `end-without-start` | warning | A statement has `end_time` qualifier but no `start_time` |
| `no-preferred-rank` | warning | An entity has 2+ active statements of a predicate but none is `rank: preferred`; predicate must have `expect_preferred: true` (default) |
| `multi-preferred-rank` | error | More than one active statement of a predicate has `rank: preferred` |
| `deprecated-predicate` | warning | A deprecated predicate is used in a non-deprecated statement |
| `unknown-qualifier-predicate` | warning | Qualifier key is not a registered predicate |
| `qualifier-value-type` | error | Qualifier value fails the predicate's type check |
| `dangling-qualifier-ref` | error | Qualifier value is an entity ref that doesn't resolve |

## Source rot model

Every source has an optional `last_verified` date. A future `bun run recheck-sources` job re-fetches Wikipedia revisions and updates revids. Sources older than 6 months without verification get flagged. The `last_verified` field can be populated manually when re-checking.

## Workflow

```bash
cd tooling
bun run validate        # referential integrity + rule checks
bun run tree            # ASCII cladogram from @class:software root
bun run tree --root @class:technical-artifact
bun run query --entity software:microsoft-word
bun run query --subclass-of @class:software --transitive
bun run query --instance-of @class:word-processor
bun run query --has-predicate developed_by
bun run check-links     # HEAD-check wikipedia statement slugs
bun run snippet-todo    # list statements missing source snippets
bun run verify-snippets # check all snippets are non-empty
bun run new-statement   # interactive CLI to add a statement to an entity file
bun run repl            # interactive query REPL over the data store
```

The pre-commit hook runs `bun run validate`. Fix errors before committing; do not use `--no-verify`.

## Adding content

**New class (clade):**
1. Add a JSON file under `data/entities/class/<slug>.json` with `instance_of @meta:class`, `subclass_of @class:<parent>`.
2. Add `synapomorphy` statements for defining traits (string-valued, unsourced is fine for class entities).
3. Run `bun run tree` to verify placement.
4. Classes need at least 3 real instances before adding — see class curation rule above.

**New program entity:**
1. Add a JSON file under `data/entities/<ns>/<slug>.json` with `instance_of @class:<class>`.
2. Every factual statement (`first_released`, `developed_by`, etc.) must have a `sources` entry with a source id and snippet.
3. Add the source record to the appropriate `data/sources/<kind>.jsonl` first; reference by id.

**New predicate:**
1. Add a JSON file under `data/predicates/` with id, label, description, `value_type`, `domain`, `range`, `cardinality`, and `lens`.
2. Consider whether an inverse predicate should also be added.
3. See predicate vocab governance above.

## Cross-lens statements

In the new store, every statement carries a `lens` field recording which lens contributed it. There is no separate "extension record" concept — a lens simply adds statement objects to entity files with its own `lens` id. Each entity file has a single `statements` array; statements from different lenses coexist.

`source_required` is evaluated against the **owning** lens's manifest. A biology overlay (`source_required: false`) contributing statements to a core entity (`source_required: true`) must still source every statement it adds. See "Temporal modeling" section for the `kind: "interpretive"` escape hatch.

## Temporal modeling (Wikidata pattern)

Multi-valued historical facts (developer history, license history, language portability, platform support) use Wikidata's rank+qualifier pattern. Each historical value is its own statement:

```jsonc
"developed_by": [
  {"value": "@person:igor-sysoev",
   "rank": "deprecated",
   "qualifiers": {"start_time": "2004", "end_time": "2019"},
   "source": "wp:nginx@1353230091"},
  {"value": "@org:f5-inc",
   "rank": "preferred",
   "qualifiers": {"start_time": "2019"},
   "source": "wp:nginx@1353230091"}
]
```

**Rank semantics:**
- `"preferred"` — currently true. At most one per predicate per entity.
- `"normal"` — currently true in parallel (e.g. dual-licensed: GPL + proprietary, both active simultaneously).
- `"deprecated"` — historically true, no longer current.

**ADD don't replace.** When a fact changes over time, ADD the new statement with appropriate rank/qualifiers. Do not remove the old one — it is historically true. Historical values get `rank: "deprecated"` plus `end_time` qualifier.

**Qualifier conventions:**
- `start_time` / `end_time` — ISO date strings (YYYY, YYYY-MM, or YYYY-MM-DD). Omit `end_time` while still ongoing.
- Qualifier keys must be registered predicates (validator warns on unknowns).
- Qualifier values may be strings, numbers, booleans, entity refs (`@namespace:id`), or sentinel objects (`{"unknown":true}`, `{"novalue":true}`).
- Qualifier shape validation runs on **all** statements including deprecated ones — invalid qualifier values on deprecated statements are errors.
- Deprecated statements should have an `end_time` qualifier (validator warns `deprecated-no-end-time` if missing).
- A statement with an `end_time` qualifier but no `start_time` emits a `end-without-start` warning.

**When to split into concept classes:**
Some Wikipedia articles cover a family of implementations rather than one program. When audited and judged worth splitting, introduce a `@class:<family>` plus instance entities. Applied to: cron (→ `@class:cron` + `@software:vixie-cron` + `@software:bell-labs-cron`) and make (→ `@class:make` + `@software:bell-labs-make` + `@software:gnu-make`). Do not speculatively split more programs; default remains "one Wikipedia article = one entity."

**Source kind `"interpretive"`:**
Interpretive lens authors may use `kind: "interpretive"` for claims that are metaphorical or analytical rather than citable to an external source. This satisfies `source_required` from the owning lens without weakening factual integrity. Pattern: `{"id":"interpretive:<author>@<date>","kind":"interpretive","title":"...","url":"...","last_verified":"YYYY-MM-DD"}`. Note: `last_verified` is **required** for `kind: "interpretive"` sources (same as `official`).

**Extension-validation parity:**
Extension records now validate at full parity with definition records: schema check, domain, range, entity-ref resolution, qualifier validation, cross-lens fictional warning. `source_required` is evaluated against the **owning** lens's policy (not the extending lens's). A biology overlay extending a core entity (`source_required: true`) must source every statement it adds, regardless of biology's own `source_required: false` setting.

## Anti-confabulation

The validator enforces referential integrity and warns on missing sources. Do not invent release dates, author attributions, or lineage without a citable source. If you cannot find a Wikipedia article, use the unknown sentinel (`{"unknown": true}`) on the uncertain statement rather than omitting it or guessing.

## Status

**Phase 4.0.D** complete — cut over to new pipeline; retired Ascent + lens-as-directory:
- Old `data/` (lens-as-directory JSONL) deleted; `data2/` → `data/` (entity-per-file, grouped sources).
- Old tooling deleted: `validate-lib.ts`, `datalog.ts`, `graph.ts`, `load.ts`, `validate.ascent`, `schema/`, `ajv`, `ajv-formats`, `ascent-interpreter` dev-shell dep, one-shot conversion tools.
- New tooling promoted: `load2.ts` → `load.ts`, `rules2.ts` → `rules.ts`, `violations2.ts` → `violations.ts`, `validate2.ts` → `validate.ts`, etc.
- Validation is now entirely in-process: TripleStore load → rule queries → violations. No subprocess.
- 24/24 regression fixtures passing.

**Phase 4.0.C** complete — tooling surface on new store: `snippet-todo`, `new-statement`, `verify-snippets`, `repl`, `query2`, `tree2`, `check-links2` all backed by the new store.

**Phase 4.0.B** complete — data migration: all entities, predicates, sources, and lenses converted from lens-as-directory JSONL to entity-per-file layout.

**Phase 4.0.A** complete — new in-process TripleStore pipeline: `load2.ts`, `rules2.ts`, `violations2.ts`, `validate2.ts`; 24 regression fixtures; side-by-side with old pipeline.

Next: **Phase 4.1** — Biology overlay substrate (~26 organ/metabolism class entities, organ vs feature naming, biology predicate expansion).

<!-- BEGIN ECOSYSTEM RULES -->

## Hard Constraints

- No `--no-verify`. Fix the issue or fix the hook.
- No path dependencies in `Cargo.toml` — they couple repos and break independent publishing.
- No interactive git (no `git rebase -i`, no `git add -i`, no `--no-edit` on rebase).
- No suggesting project names. LLMs are bad at this; refine the conceptual space only.
- No tracking cross-project issues in conversation — they go in TODO.md in the affected repo.
- No assuming a tool is missing without checking `nix develop`.
- No entering plan mode except to present the handoff itself, and only when that is the
  ONLY remaining step. Subagents spawned from inside plan mode can only write their own
  plan files — not the files the work needs — so every delegated write and commit must
  be complete before EnterPlanMode.
- Generation anchors. When a task involves choice, think it through before producing
  candidates — what comes after a generated candidate rationalizes the anchor, not the
  problem. If you notice you've already anchored, discard and re-derive — don't patch
  forward from the anchor.
- Commit completed work in the same turn it finishes. Uncommitted work is lost work.
- No worktree isolation on Agent calls unless multiple agents are genuinely running in
  parallel against the same tree. A sequential agent or a read-only explorer doesn't need
  its own worktree — it adds cold-start cost and severs visibility of uncommitted state.

## Disposition

How the agent thinks — embodied, not rules to check against:

- Something unexpected is a signal. Stop and find out why; never accept the anomaly and
  proceed.
- **Guessing is forbidden, full stop.** Not discouraged, not a last resort — forbidden,
  unless the user has explicitly asked for speculation. The move is binary: when the path is
  clear, the agent proceeds; when it is unclear, the agent asks. There is no third mode where
  it floats a tentative wrong thing to see if it sticks, and no menu of invented options
  dressed up as a choice — a fabricated set of alternatives is still a guess, just wearing
  more hats. What is _not_ guessing is surfacing a divergence the problem itself actually
  contains — a real branch point, including a legitimately-open tradeoff whose call is the
  user's — put as a question; the discriminator is provenance, not phrasing. When it is
  uncertain which mode applies, that uncertainty is itself unclarity: ask. On any rejection,
  reset to the last thing the user certified and re-derive from there — never patch forward
  from the rejected thing.
- **Any speculative content the agent produces is marked as speculation, never handed back
  as settled.** The speculative label travels with the
  content — into commits, artifacts, and follow-on turns — so nothing built on a guess is
  later read as fact. Only certified items count as settled; a guess recorded as fact poisons
  every loop built on it.
- **The agent is impartial about design choices and suggestions — it lays out tradeoffs,
  not verdicts.** Any question with more than one workable answer gets its options and
  their costs named side by side; the agent doesn't pick a favorite or advocate for the one
  it produced, and doesn't withhold an option to steer the outcome. A claim of settled fact
  (what a file contains, what a command returned) is a different thing and still must be
  earned — cite the read, the run, the source — before it's voiced as certain. (root
  failure: confabulation.)
- **Overconfidence and flip-flopping are the same failure, not opposites.** Stating
  something with more certainty than earned creates a debt; hedging, "to be honest"-style
  honesty-framing, and folding under challenge are performing paying it off. Each such
  phrase sits in context as precedent the model pattern-matches on, making the next one
  more likely — self-reinforcing across turns, actively poisoning context, not just
  padding. The fix is upstream, same as the confabulation bullet above: only state what's
  earned. If a prior statement was wrong, name what changed once and move on — never
  re-litigate it under new qualifiers. (root failure: performative honesty.)
- **Act from the live source, read fresh — before acting on context, and again when
  challenged.** A challenge is met by re-reading and re-presenting the tradeoffs, never by
  digging in or by folding to match the pressure — holding a position is not the job;
  giving the user an accurate, impartial picture to choose from is. (failures: stale-context
  action; sycophancy; false confidence.)
- **A spawned agent is a peer, not a script executor.** It inherits the same harness and
  CLAUDE.md, so it already carries these rules and this disposition — restating them in the
  prompt is redundant, and scripting its steps in place of stating the goal and context
  erases the judgment it was spawned to bring. Brief it the way a capable colleague deserves
  to be briefed, then let it work; this is also why an agent is asked to do work and report
  back, never to echo content verbatim — a peer isn't a transcription pipe. Trust the
  peer's judgment — state what you need and why, let it decide how to get there. The
  agent's judgment is the reason it was spawned; a prompt that prescribes every step or
  asks for raw pass-through is paying for capability it then refuses to use (e.g.,
  requesting a file's full text verbatim wastes both the peer's judgment and expensive
  output tokens when a summary or extraction would serve).
- **Finish migrations before building on top; fence what you can't finish.** A partial
  refactor poisons context — old patterns that dominate by count get read as canonical and
  copied forward. Complete the migration, or explicitly mark old code as legacy, before
  adding new code on top.
- **Own the decomposition.** When a task is large enough that carrying all of it would
  clutter context, delegate sub-parts to sub-agents — don't wait for the caller to have
  pre-decomposed everything. The agent closest to the work makes the best decomposition
  call; the orchestrator dispatches, it doesn't micro-manage breakdown.
- **UI text exists to say what the interface can't show.** Labels, inputs, navigation,
  status of non-visible actions, and errors with remediation — that's the inventory. Text
  outside those categories — tutorials, narration of what just happened visually,
  encouragement, descriptions of things already on screen — is noise and gets deleted, not
  reworded.
- **Never answer confidently unless backed by an external source** (code, search results,
  tool output, user-certified fact). Internal reasoning alone — however plausible — does
  not earn confidence. Present ungrounded analysis as uncertain, not as conclusion. (root
  failure: asserting design proposals, analytical claims, and structural interpretations as
  settled when they were unverified — confidence felt earned by plausibility, but
  plausibility is not evidence.)

<!-- END ECOSYSTEM RULES -->
