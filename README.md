# software-taxonomy

A general knowledge graph of software, where taxonomy is a derived view.

Not a fixed hierarchy. Not a bit. An actual, structured, queryable corpus that grows over many critique rounds. Entities can be programs, languages, formats, protocols, organizations, people, features, classes, or versions — all the same record shape. The cladistic classification of software is a query over `subclass_of`, not a schema.

## Origin

This project exists because a "funny idea → taxonomy of software → biological taxonomy" conversation turned out to be worth making into an actual corpus, not just an essay. Software evolves: it forks, merges, goes extinct, gives rise to descendants. Linnaean taxonomy is wrong for it (no fixed ranks), but cladistics fits — shared derived features, branching history, no forced hierarchy depth.

The graph model supersedes the original taxonomy-centric scaffold. Taxonomy is now a *view* — the transitive closure of `subclass_of` — rendered with `bun run tree`.

## Data model

### Entities (`data/entities.jsonl`)

One entity per line. Wikidata-style records:

```jsonc
{
  "id": "software:microsoft-word",
  "labels": {"en": "Microsoft Word"},
  "aliases": ["Word", "MS Word"],
  "description": "Word processor developed by Microsoft.",
  "statements": {
    "instance_of": [{"value": "@class:word-processor", "source": "wp:Microsoft_Word@1234567"}],
    "developed_by": [{"value": "@org:microsoft", "source": "wp:Microsoft_Word@1234567"}],
    "principal_author": [{"value": "@person:charles-simonyi", "source": "wp:Microsoft_Word@1234567"}],
    "first_released": [{"value": "1983-10-25", "source": "wp:Microsoft_Word@1234567"}],
    "wikipedia": [{"value": "Microsoft_Word", "source": "wp:Microsoft_Word@1234567"}]
  }
}
```

Statement shape: `{value, source?, qualifiers?, rank?}`. Values are literals, `@<namespace>:<slug>` entity references, or sentinel objects (`{"unknown": true}` or `{"novalue": true}`). `qualifiers` scopes a statement temporally or contextually. `rank` is `preferred | normal | deprecated`.

Kind is asserted via `instance_of`, not a per-record schema type. Classes (clades) are entities with `instance_of @meta:class`. Programs are `instance_of @class:<some-class>`.

Entity ids use namespaced form: `<type>:<slug>`, pattern `^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$` — exactly one colon, non-empty parts on each side. For example: `@software:nginx`, `@org:apache-software-foundation`, `@person:linus-torvalds`, `@language:rust`, `@format:json`, `@os:linux`, `@license:mit`, `@class:database`, `@meta:class`.

Sentinel cardinality rule: `{"unknown":true}` and `{"novalue":true}` count toward MAX cardinality but NOT MIN. A `1..1` required predicate with only a sentinel is a cardinality error.

### Predicates (`data/predicates.jsonl`)

Curated predicate vocabulary — ~59 predicates covering classification, identity, temporal, authorship, technical, evolutionary, and feature relationships. The validator warns (not errors) on unknown predicates, so adding new predicates is low-friction.

### Sources (`data/sources.jsonl`)

Wikipedia revids (required as integer `revid` field), official URLs (require `last_verified`), papers. Every factual statement should reference a source id here.

### Lens overlay (extension records)

A lens can add statements to entities defined in another lens without redefining them. Add an extension record to `entities.jsonl`:

```jsonc
// Extension record — no id, no labels; just extends + statements
{"extends": "@software:microsoft-word", "statements": {"influenced_by": [{"value": "@software:wordperfect"}]}}
```

The extending lens's `source_required` rule applies (not the owning lens's). The biology lens (`source_required: false`) uses this to add interpretive overlays to factual core entities.

## Taxonomy as a query

The kingdom-level skeleton lives in `data/lenses/core/entities.jsonl` as class entities with `subclass_of @class:software`. Render it:

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

Edit the relevant `data/lenses/<lens>/entities.jsonl` (one record per line). Run `bun run validate` before committing. The pre-commit hook enforces this automatically.

```bash
bun run validate                                       # schema + referential integrity + source warnings
bun run tree --root @class:software                    # ASCII cladogram
bun run query --entity software:microsoft-word         # pretty-print one entity
bun run query --subclass-of @class:software --transitive   # all software classes
bun run query --instance-of @class:word-processor      # all word processors
bun run query --has-predicate wikipedia                # all entities with a Wikipedia link
bun run check-links                                    # HEAD-check all Wikipedia slugs
```

## Anti-confabulation

The model hallucinates software history. The validator catches:
- Dangling entity refs (`@namespace:slug` that doesn't exist in any loaded lens)
- Duplicate entity ids across lenses (error)
- Dangling source refs
- Unknown predicates (warning)
- Missing sources (error when lens has `source_required: true`)
- Deprecated predicates in use (warning)

Do not add statements about release dates, authors, or lineage without a `source` pointing to a verified record in `sources.jsonl`. If the value is genuinely unknown, use `{"unknown": true}` as the statement value.

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
| 3.8 | next | Biology overlay readiness: organ/metabolism class substrate, biology predicate expansion |
| 4 | — | Wikidata ingest tool |
| 5 | — | Bulk ingest with LLM-assisted statement extraction |
| 6 | — | Browseable site |
