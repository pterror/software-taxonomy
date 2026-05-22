# software-taxonomy

## Origin

A cladistic taxonomy of software as living organisms — started as a conversation, became a corpus. The key insight: software evolves like biology (forks, merges, convergent solutions, extinct lineages), and cladistics (not Linnaean ranks) fits it best. Phase 1 inverted the original schema: the primary artifact is a **general knowledge graph**; taxonomy is a derived view over `subclass_of`.

The repo is a standalone public corpus at https://github.com/pterror/software-taxonomy.

## Model

- `data/entities.jsonl` — one entity per line, Wikidata-style. Any kind of entity: program, language, format, organization, person, feature, class.
- `data/predicates.jsonl` — curated predicate vocabulary (~45 predicates). Validator warns on unknowns.
- `data/sources.jsonl` — provenance records (Wikipedia revids, official URLs, etc.).
- `schema/entity.schema.json`, `schema/predicate.schema.json`, `schema/source.schema.json` — JSON Schema Draft 2020-12.

A clade is an entity with `instance_of @class`. The class hierarchy is `subclass_of` chains. Programs are `instance_of @some-class`. Everything else (people, orgs, features) is typed by their own `instance_of` statements.

## Conventions

- Entity ids: kebab-case, `^[a-z0-9][a-z0-9-]*$`.
- Predicate ids: snake_case, `^[a-z][a-z0-9_]*$`.
- Entity refs in statement values: `@entity-id` prefix.
- Source ids in statements: must exist in `sources.jsonl`.
- Every factual claim needs a `source`. Class structure (synapomorphies, etymologies, rank hints) is intrinsic; sourcing is aspirational but currently unsourced.
- One record per line in all `.jsonl` files. Recompact with `jq -c`.

## Workflow

```bash
cd tooling
bun run validate        # schema + referential integrity
bun run tree            # ASCII cladogram from @software root
bun run query --entity <id>
bun run query --subclass-of @<class> --transitive
bun run query --instance-of @<class> [--transitive]
bun run query --has-predicate <pred>
bun run check-links     # HEAD-check wikipedia statement slugs
```

The pre-commit hook runs `bun run validate`. Fix errors before committing; do not use `--no-verify`.

## Adding content

**New class (clade):**
1. Add entity with `instance_of @class` and `subclass_of @<parent>`.
2. Add `synapomorphy` statements for defining traits (string-valued, unsourced is fine for class entities).
3. Run `bun run tree` to verify placement.

**New program entity:**
1. Add entity with `instance_of @<class>`.
2. Every factual statement (`first_released`, `developed_by`, etc.) must have a `source` pointing to a record in `sources.jsonl`.
3. Add the source record first; reference by id.

**New predicate:**
1. Add to `data/predicates.jsonl` with id, label, description, and optional inverse/transitive/domain_hint/range_hint.
2. Consider whether an inverse predicate should also be added.

## Anti-confabulation

The validator enforces referential integrity and warns on missing sources. Do not invent release dates, author attributions, or lineage without a citable source. If you cannot find a Wikipedia article, note the entity as unverified via a `rank` qualifier on the uncertain statement.

## Status

**Phase 1** complete — knowledge-graph model in place, 11 class entities migrated (10 original kingdoms/orders + root `@class` meta-entity), tooling rewritten. Awaiting Phase 2 breadth seed.
