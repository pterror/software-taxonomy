# software-taxonomy

A real, structured, queryable cladistic taxonomy of software treated as biological organisms — JSONL corpus with rich featuresets and modelled evolutionary history.

## Origin

This project exists because a "funny idea → taxonomy of software → biological taxonomy" conversation turned out to be worth making into an actual corpus, not just an essay. Software evolves: it forks, merges, goes extinct, gives rise to descendants. Linnaean taxonomy is wrong for it (no fixed ranks), but cladistics fits — shared derived features, branching history, no forced hierarchy depth.

Personal research artifact, sibling to matrix-gen, ashwren, fuwafuwa. The goal is to eventually cover every program known to the model, then every program known to Wikipedia, with rich featuresets and modelled evolutionary history.

## Data model

See `schema/` for the JSON Schema definitions. Records are stored as JSONL in `data/`: three coupled files — `clades.jsonl`, `species.jsonl`, and `edges.jsonl` — plus `sources.jsonl`. The taxonomy is variable-depth cladistic (no fixed Linnaean ranks); every record is sourced; species represent program lineages (e.g. Word from 1983 to today is one species; Word vs Word Online are separate species joined by a `forked_from` edge).

## Workflow

```bash
cd tooling && bun install   # once
```

Edit `data/*.jsonl` to add or update records. Run `bun run validate` before committing. The pre-commit hook enforces this automatically.

## Conventions

- Ids are kebab-case ASCII (e.g. `microsoft-word`, `kingdom-documenta`).
- Species records use program-lineage scope: one version line through time = one species. Forks become separate species joined by a `forked_from` edge.
- Every factual claim must point to a source in `sources.jsonl` via a `source_ids` array.

## Anti-confabulation

The model hallucinates software history. The validator catches missing sources. Do not add a species record without at least one Wikipedia source. If you cannot find a Wikipedia article for a program, note it as `unverified: true` and leave a comment — do not invent publication dates, authors, or lineage without a citation.
