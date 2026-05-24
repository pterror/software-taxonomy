# software-taxonomy

A general knowledge graph of software, where taxonomy is a derived view.

Not a fixed hierarchy. Not a bit. An actual, structured, queryable corpus that grows over many critique rounds. Entities can be programs, languages, formats, protocols, organizations, people, features, classes, or versions — all the same record shape. The cladistic classification of software is a query over `subclass_of`, not a schema.

## Origin

This project exists because a "funny idea → taxonomy of software → biological taxonomy" conversation turned out to be worth making into an actual corpus, not just an essay. Software evolves: it forks, merges, goes extinct, gives rise to descendants. Linnaean taxonomy is wrong for it (no fixed ranks), but cladistics fits — shared derived features, branching history, no forced hierarchy depth.

The graph model supersedes the original taxonomy-centric scaffold. Taxonomy is now a *view* — the transitive closure of `subclass_of` — rendered with `bun run tree`.

## Data layout

```
data/
  entities/<ns>/<slug>.json     one file per entity
  predicates/<id>.json          one file per predicate
  sources/<kind>.jsonl          source records grouped by kind
  lenses/<lens-id>.json         lens identity and metadata
```

### Entity file

```jsonc
{
  "id": "software:microsoft-word",
  "labels": {"en": "Microsoft Word"},
  "aliases": ["Word", "MS Word"],
  "description": "Word processor developed by Microsoft.",
  "statements": [
    {
      "id": "s:abc1234",
      "predicate": "@core:instance_of",
      "value": "@class:word-processor",
      "lens": "@core",
      "rank": "preferred",
      "sources": [{"id": "wp:Microsoft_Word@1234567", "snippet": "Microsoft Word is a word processing application..."}]
    }
  ]
}
```

Statement shape: `{id, predicate, value, lens, rank?, qualifiers?, sources?}`. Values are literals, `@<namespace>:<slug>` entity references, or sentinel objects (`{"unknown": true}` or `{"novalue": true}`). `sources` is an array of `{id, snippet}` — each sourced statement must include the verbatim `snippet` from the source that supports the claim.

Kind is asserted via `instance_of`, not a per-record schema type. Classes (clades) are entities with `instance_of @meta:class`. Programs are `instance_of @class:<some-class>`.

Entity ids use namespaced form: `<type>:<slug>`, pattern `^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$`. For example: `@software:nginx`, `@org:apache-software-foundation`, `@person:linus-torvalds`, `@language:rust`, `@format:json`, `@os:linux`, `@license:mit`, `@class:database`, `@meta:class`.

Sentinel cardinality rule: `{"unknown":true}` and `{"novalue":true}` count toward MAX cardinality but NOT MIN. A `1..1` required predicate with only a sentinel is a cardinality error.

### Predicates

Curated predicate vocabulary — ~59 predicates covering classification, identity, temporal, authorship, technical, evolutionary, and feature relationships. The validator warns (not errors) on unknown predicates, so adding new predicates is low-friction.

### Sources

Wikipedia revids (required as integer `revid` field), official URLs (require `last_verified`), papers. Every factual statement should reference a source id here.

### Lenses

Each lens has a `source_required` flag. When `true`, every factual statement contributed by that lens must have a non-empty `sources` array with snippets. Structural predicates (`instance_of`, `subclass_of`) on class entities are exempt.

## Taxonomy as a query

The kingdom-level skeleton lives in `data/entities/class/` as class entities with `subclass_of @class:software`. Render it:

```bash
cd tooling
bun run tree --root @class:software         # rooted at software
bun run tree --root @class:technical-artifact  # software + formats + protocols + specs
bun run tree --root @class:documenta        # biology lens subtree
```

## Workflow

```bash
cd tooling && bun install   # once
```

Edit entity files under `data/entities/`. Run `bun run validate` before committing. The pre-commit hook enforces this automatically.

```bash
bun run validate                                       # referential integrity + rule checks + source warnings
bun run test-fixtures                                  # regression fixture tests (24 fixtures)
bun run tree --root @class:software                    # ASCII cladogram
bun run query --entity software:microsoft-word         # pretty-print one entity
bun run query --subclass-of @class:software --transitive   # all software classes
bun run query --instance-of @class:word-processor      # all word processors
bun run query --has-predicate wikipedia                # all entities with a Wikipedia link
bun run check-links                                    # HEAD-check all Wikipedia slugs
bun run snippet-todo                                   # list statements missing source snippets
bun run verify-snippets                                # check all snippets are non-empty
bun run new-statement                                  # interactive CLI to add a statement
bun run repl                                           # query REPL
```

## How validation works

`bun run validate` loads the full corpus into an in-process EAV TripleStore (`@thi.ng/rstream-query`) and runs all rules in a single TypeScript process — no subprocess, no external schema layer.

The loader (`tooling/src/lib/load.ts`) reads `data/` and transacts entities, predicates, sources, and lenses into a `Db`. Rules (`tooling/src/lib/rules.ts`) query the store for violations: referential integrity, cardinality, domain/range, multi-preferred, source-required, cross-lens fictional, alias cycles, temporal qualifier rules.

Alias constraints cascade: `alias_of` predicates inherit domain, range, cardinality, and expect_preferred from their canonical predicate. Source-required checks are per-statement — a sourced sibling doesn't exempt an unsourced one.

To add a new rule: write a function in `tooling/src/lib/rules.ts` that accepts a `Db` and returns `Violation[]`, then register it in `runAllRules`.

## Anti-confabulation

The model hallucinates software history. The validator catches:
- Dangling entity refs (`@namespace:slug` that doesn't exist in any loaded lens)
- Duplicate entity ids across lenses (error)
- Dangling source refs
- Unknown predicates (warning)
- Missing sources (error when lens has `source_required: true`)
- Deprecated predicates in use (warning)

Do not add statements about release dates, authors, or lineage without a `sources` entry pointing to a verified record in `data/sources/` and including the verbatim snippet. If the value is genuinely unknown, use `{"unknown": true}` as the statement value.

## Roadmap

| Phase | Status | Output |
|-------|--------|--------|
| 0 | done | Old taxonomy-centric scaffold (superseded) |
| 1 | done | Knowledge-graph model: new schemas, migrated class entities, rewritten tooling |
| 2 | done | Breadth seed: ~45 programs across Documenta/Servitora/Automata/Oracula |
| 3 | done | Depth seed: multi-lens architecture (biology, folklore, mythology-demo) |
| 3.5 | done | Pre-Phase-4 hardening: namespaced ids, supertype classes, sentinel values, validator hardening |
| 3.6 | done | Cross-lens extension records, sentinel cardinality semantics, id pattern strictness, multi-preferred error, qualifier validation, factual corrections, predicate relocation |
| 3.7 | done | Validator parity (extension records), temporal modeling discipline (Wikidata rank pattern), concept-class splits (cron, make), two audit waves of temporal/multi-value corrections (~28 programs), tooling fixes |
| 3.8 | done | Validator refactor (single validateStatementEntry), qualifier validation on deprecated, multi-preferred on merged graph, qualifier entity-ref/sentinel support, new warnings (deprecated-no-end-time, end-without-start, no-preferred-rank), interpretive source last_verified, temporal completions (vim, sublime-text, vscode), PostgreSQL concept split |
| 3.9 | done | Migrate graph-invariant validation from TypeScript to Datalog (ascent-interpreter); 18 rule clusters in validate.ascent; regression fixture system |
| 3.10 | done | Fix 6 regressions from 3.9 migration: statement-indexed facts, alias constraint cascade, predicate provenance, per-lens summary, migration completion (3 more checks to Datalog); 5 → 24 fixtures with multiplicity harness |
| 4.0 | done | New pipeline: entity-per-file store, in-process TripleStore, rules-as-queries, snippet provenance; retired Ascent + lens-as-directory + AJV |
| 4.1 | next | Biology overlay substrate: organ/metabolism class entities, organ vs feature naming, biology predicate expansion |
| 4 | — | Wikidata ingest tool |
| 5 | — | Bulk ingest with LLM-assisted statement extraction |
| 6 | — | Browseable site |
