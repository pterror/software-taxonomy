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
  "id": "ms-word",
  "labels": {"en": "Microsoft Word"},
  "aliases": ["Word", "MS Word"],
  "description": "Word processor developed by Microsoft.",
  "statements": {
    "instance_of": [{"value": "@wordprocessoria"}],
    "developed_by": [{"value": "@microsoft"}],
    "first_released": [{"value": "1983-10-25", "source": "wp:Microsoft_Word@1234567"}],
    "wikipedia": [{"value": "Microsoft_Word"}]
  }
}
```

Statement shape: `{value, source?, qualifiers?, rank?}`. Values are literals or `@entity-id` references. `qualifiers` scopes a statement temporally or contextually. `rank` is `preferred | normal | deprecated`.

Kind is asserted via `instance_of`, not a per-record schema type. Classes (clades) are entities with `instance_of @class`. Programs are `instance_of @some-class`.

### Predicates (`data/predicates.jsonl`)

Curated predicate vocabulary — ~45 predicates covering classification, identity, temporal, authorship, technical, evolutionary, and feature relationships. The validator warns (not errors) on unknown predicates, so adding new predicates is low-friction.

### Sources (`data/sources.jsonl`)

Wikipedia revids, official URLs, papers. Every factual statement should reference a source id here.

## Taxonomy as a query

The kingdom-level skeleton lives in `data/entities.jsonl` as class entities with `subclass_of @software`. Render it:

```bash
cd tooling
bun run tree                        # rooted at @software
bun run tree --root @documenta      # subtree
```

## Workflow

```bash
cd tooling && bun install   # once
```

Edit `data/entities.jsonl` (one record per line). Run `bun run validate` before committing. The pre-commit hook enforces this automatically.

```bash
bun run validate                               # schema + referential integrity + source warnings
bun run tree                                   # ASCII cladogram
bun run query --entity documenta               # pretty-print one entity
bun run query --subclass-of @software --transitive   # all software classes
bun run query --instance-of @wordprocessoria   # all word processors
bun run query --has-predicate wikipedia        # all entities with a Wikipedia link
bun run check-links                            # HEAD-check all Wikipedia slugs
```

## Anti-confabulation

The model hallucinates software history. The validator catches:
- Dangling entity refs (`@id` that doesn't exist in entities.jsonl)
- Dangling source refs
- Unknown predicates (warning)
- Missing sources (warning, except structural predicates on class entities)

Do not add statements about release dates, authors, or lineage without a `source` pointing to a verified record in `sources.jsonl`.

## Phasing

| Phase | Output |
|-------|--------|
| 0 | Old taxonomy-centric scaffold (superseded) |
| 1 | Knowledge-graph model: new schemas, migrated class entities, rewritten tooling |
| 2 | Breadth seed: ~40 programs + their referenced entities |
| 3 | Depth seed: Wordprocessoria + feature entities |
| 4 | Wikipedia ingest tool |
| 5 | Bulk ingest with LLM-assisted statement extraction |
| 6 | Browseable site |
