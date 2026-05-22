# software-taxonomy

A cladistic classification of software as living organisms.

Not an essay. Not a bit. An actual, structured, queryable corpus that grows over many critique rounds. The goal is rich per-species metadata — featuresets, habitats, metabolism, evolutionary history — across every program the model knows, and eventually every program Wikipedia knows.

## Status

**Phase 0** — schema scaffolded, kingdom-level clades stubbed. Awaiting first critique round before seed entries.

See `../docs/introspection/investigations/` and the conversation that spawned this for the framing.

## Layout

```
schema/         JSON Schemas for each record type
data/           the corpus (JSONL, line-diffable)
  clades.jsonl     cladistic tree (variable depth, no fixed Linnaean ranks)
  species.jsonl    one organism per line, rich record
  edges.jsonl      evolutionary multi-graph (descent, influence, convergence, parasitism, ...)
  sources.jsonl    provenance (Wikipedia revids, official URLs)
tooling/        bun + TypeScript CLI (validate, query, tree)
```

## Why cladistic, not Linnaean

Linnaean ranks (kingdom/phylum/class/.../species) are tidy but lie about how taxa actually relate. Real modern taxonomy is cladistic — nested clades, variable depth, no commitment that "every kingdom has exactly seven sub-levels." Software lineages have wildly uneven depth (an LLM-agent species is four nodes from the root; a Lisp dialect descendant is twelve), so the same logic applies. The `rank_hint` field on clades exists only because humans still think in ranks.

## What counts as a species

A program-lineage, not a version. Microsoft Word from 1983 to today is **one** species; its UI history (menu-bar → ribbon → backstage view) lives in `morphology.ui_history` and feature timestamps. A rewrite that changes metabolism — e.g. Word → Word Online (browser-native, different inputs, different distribution) — gets a separate species joined by a `forked_from` edge.

## Validator-enforced anti-confabulation

Every factual claim in a species record points to a `sources.jsonl` id. The validator flags fields without sources as `unverified` and refuses to bless a record as ready until each claim is sourced. The model will hallucinate Microsoft products that never shipped; the validator catches it.

## Workflow

1. Edit `data/*.jsonl` (one record per line — keep line breaks; `jq -c` to recompact).
2. `cd tooling && bun run validate` — schemas + referential integrity.
3. `bun run tree --root cellularia` — eyeball the cladogram.
4. `bun run query --in-clade <id>` — review a slice.
5. Critique round. Repeat.

## Phasing

| Phase | Output |
|-------|--------|
| 0 | Schemas + kingdom-level clade skeleton (this commit) |
| 1 | Breadth seed: ~40 species, one or two per major clade |
| 2 | Depth seed: ~40 species, exhaustive within Wordprocessoria |
| 3 | Wikipedia ingest tool (REST API; not scraping) |
| 4 | Bulk Wikipedia ingest with LLM-assisted classification + human review |
| 5 | Browseable site |

Phases 3+ get re-planned when reached.
