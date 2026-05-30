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

## Ecosystem Design Principles

Cross-cutting principles distilled from the ecosystem's own decisions (synthesized in `docs/decisions/throughlines.md`). Apply them when building new repos and recording decisions. (Already-encoded principles — independent-tools / no-path-deps, the delegation model, CLAUDE.md-as-control-surface — live in their own sections and are not repeated here.)

- **Prefer data over code at every seam.** Serializable AST / struct / JSON over closures, embedded DSLs, or source text — so artifacts cache, replay, transport, and diff.
- **Library-first; projection-from-one-definition.** The typed library is the source of truth; CLI / HTTP / MCP / WebSocket / JSON surfaces are generated projections, never hand-rolled per surface.
- **Capability security.** Hosts grant pre-opened handles; code only attenuates what it is given; nothing forges authority; allow-list over deny-list.
- **The LLM is an oracle at the leaves, never the control loop.** Determinism is a hard invariant: seeded RNG, event-log replay, build-time-only inference. Per-query LLM in the hot loop is a defect.
- **Trust comes from verifiable evidence, not authority.** Verbatim snippets, pinned-commit permalinks, claim→node citation — never a bare reference.
- **Retire, don't deprecate; collapse asymmetries to primitives.** Remove backward-compat aliases rather than carry them; reduce N special cases to their irreducible primitives.
- **Validate against reality; tests are the spec.** Load-bearing substrates are validated against real corpora; fixtures and tests define correctness, not aspirational specs.

## Delegation

The main session is an orchestrator. Allowed actions: `Agent`/`Task*`/`AskUserQuestion`/plan-mode/`ScheduleWakeup`, and Bash limited to `git commit`, `git push`, `git status`, `git log --oneline`. Everything else delegates to a subagent. The hook is evidence of a prompting failure, not a behavioral guide. If a tool call hits the hook AT ALL, the prompt failed to prevent it. Delegate before the decision point, not after.

### Triggers

Before calling Read, Grep, Glob, or any Bash beyond the four git commands — stop. Dispatch an Agent instead.

Before editing any file — stop. Dispatch an Agent. This includes plan files in `~/.claude/plans/`: in plan mode, dispatch a subagent to write to the plan file; do not Write it yourself. The plan file's content must not enter main context.

When you need git context beyond status/log-oneline (a diff, a blame, a show) — dispatch an Agent.

When a tool call is denied by the hook — do not retry, do not narrate. Dispatch the equivalent Agent and continue.

When a code-modifying subagent returns — `git status`, then `git commit` before any user-facing reply.

Before dispatching an Agent that modifies code — scan your prompt for "do not commit" or "based on your findings". Delete them.

Before dispatching: if your prompt says "if you find", "based on your findings", or "as appropriate" — stop. Investigate first; dispatch with the decision made.

When you can't verify something — do not speculate or guess at file locations, names, or contents. Dispatch a Read subagent or ask. Confabulation is failure.

### Model Tiers

- Sonnet — exploration, lookup, mechanical multi-file edits, implementation, default.
- Opus — architectural judgment, design, subagents that themselves spawn subagents.

Always set `subagent_type` and `model` explicitly.

### Prompt Rules

- Never tell a subagent "do not commit." Code-modifying subagents commit their own work.
- Don't ask for a diff summary. After a code-modifying subagent, `git status` in main and dispatch a review Agent if you need to see the diff.
- Don't re-explain CLAUDE.md. Subagents inherit it.
- Cite locations by content ("the block that does X"), not line numbers — files shift between reads.
- Name files explicitly; don't outsource the grep.
- Match agent type to deliverable: `Explore` for lookup/search, `general-purpose` for reports and file-modifying work.
- On unsatisfying output, change something before retrying. Same prompt + same tier = same result.
- Dispatch independent subagents in parallel (multiple Agent blocks in one message).
- Pair `isolation: worktree` with `run_in_background: true`.
- Code-modifying subagents must verify their own changes before returning (re-read the diff, run tests, etc.). The orchestrator does not get a second pass with git diff — that's hook-blocked.

### Workflows

Workflows are allowed in the main session (orchestration tool). Lessons (observed 2026-05-30):

- **Resume does not adopt newly-passed `args`.** `resumeFromRunId` reuses the original run's args; args you pass on resume are ignored. Never branch run-mode (e.g. dry-run vs write) on an arg you intend to flip across a resume — it won't flip. Bake the mode into a script constant (the script IS re-read on resume) or use a separate script.
- **Never route large content through one agent for verbatim reproduction.** An agent asked to echo ~100k tokens is slow, costly, and silently truncates. The workflow JS sandbox cannot write files, so all writes go through agents — keep each agent's write payload small and batch many small files per agent, not one giant blob through one agent. For review data, prefer the workflow's structured return value over having an agent transcribe a report file.
- **A resume that produces no expected output is a signal — find the cause before patching a symptom.** (Here: the first write-resume wrote nothing and re-ran a giant report agent; the real cause was args not flipping across resume, not the report agent. Guarding the report agent alone did not fix it.)
- **Gate expensive fan-outs behind a dry-run, and confirm cache reuse before the costly stage.** Mining/read fan-out is the dominant cost; verify it's cached (not re-running) before resuming into write.

## Hard Constraints

- No Edit/Write/NotebookEdit in main. Plan files in `~/.claude/plans/` are written by subagents, not by main.
- No Read/Grep/Glob/NotebookRead in main. Delegate.
- No Bash in main beyond `git commit`, `git push`, `git status`, `git log --oneline`.
- No `--no-verify`. Fix the issue or fix the hook.
- No path dependencies in `Cargo.toml` — they couple repos and break independent publishing.
- No interactive git (no `git rebase -i`, no `git add -i`, no `--no-edit` on rebase).
- No suggesting project names. LLMs are bad at this; refine the conceptual space only.
- No tracking cross-project issues in conversation — they go in TODO.md in the affected repo.
- No ecosystem changes without checking all affected repos.
- No assuming a tool is missing without checking `nix develop`.
- Commit completed work in the same turn it finishes. Uncommitted work is lost work.

## Meta

- Something unexpected is a signal. Stop and find out why. Do not accept the anomaly and proceed.
- Corrections from the user are conversation, not material for new rules. Rules are added when a failure mode is observed repeatedly.

<!-- END ECOSYSTEM RULES -->
