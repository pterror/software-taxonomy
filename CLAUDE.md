# software-taxonomy

## Origin

A cladistic taxonomy of software as living organisms — started as a conversation, became a corpus. The key insight: software evolves like biology (forks, merges, convergent solutions, extinct lineages), and cladistics (not Linnaean ranks) fits it best. Phase 1 inverted the original schema: the primary artifact is a **general knowledge graph**; taxonomy is a derived view over `subclass_of`.

The repo is a standalone public corpus at https://github.com/pterror/software-taxonomy.

## Model

The data lives in `data/lenses/<lens-name>/`:
- `entities.jsonl` — one entity per line, Wikidata-style. Any kind of entity: program, language, format, organization, person, feature, class.
- `predicates.jsonl` — curated predicate vocabulary. Validator warns on unknowns.
- `sources.jsonl` — provenance records (Wikipedia revids, official URLs, etc.).
- `manifest.json` — lens identity, register (`factual` | `interpretive` | `fictional` | `folkloric`), dependencies.

Top-level schema files: `schema/entity.schema.json`, `schema/predicate.schema.json`, `schema/source.schema.json` — JSON Schema Draft 2020-12.

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

Sentinels are accepted by the validator, skip type/range checks, and count as 1 satisfied statement for cardinality purposes.

## Conventions

- Entity ids: namespaced form `<type>:<slug>` using `:` separator, pattern `^[a-z0-9][a-z0-9:_-]*$`.
- Predicate ids: snake_case, `^[a-z][a-z0-9_]*$`.
- Entity refs in statement values: `@<namespace>:<slug>` prefix.
- Source ids in statements: must exist in `sources.jsonl` in any loaded lens.
- Every factual claim needs a `source`. Class structure (synapomorphies, etymologies, rank hints) is intrinsic; structural predicates (`instance_of`, `subclass_of`) on class entities are exempt.
- One record per line in all `.jsonl` files. Recompact with `jq -c`.

## Class curation rule

Classes are pre-curated by humans, never auto-invented during ingest. An ingest tool that encounters an instance not fitting an existing class proposes the new class for review rather than creating it automatically. The substrate-pre-seed pattern from Phase 3.0 is the general rule, not just a Phase-3 thing.

New class checklist:
1. Does the candidate differ meaningfully from existing classes (synapomorphy, not just label)?
2. Are there at least 3 known instances to justify a new class?
3. Does it fit cleanly under an existing superclass?

## Predicate vocab governance

- **To add a predicate**: open a PR adding it to the relevant lens's `predicates.jsonl` with full `value_type`, `domain`, `range`, `cardinality` constraints, and a `since_version` tag. Consider whether an inverse is needed.
- **To deprecate a predicate**: set `deprecated: true` and document the successor in the predicate's `description`. The validator will warn on all uses.
- **To merge near-duplicates**: set `alias_of` on the deprecated predicate pointing to the canonical. The validator resolves constraints from the canonical and logs an info message on use.

## Source rot model

Every source has an optional `last_verified` date. A future `bun run recheck-sources` job re-fetches Wikipedia revisions and updates revids. Sources older than 6 months without verification get flagged. The `last_verified` field is in `source.schema.json` and can be populated manually when re-checking.

## Workflow

```bash
cd tooling
bun run validate        # schema + referential integrity
bun run tree            # ASCII cladogram from @class:software root
bun run tree --root @class:technical-artifact
bun run query --entity software:microsoft-word
bun run query --subclass-of @class:software --transitive
bun run query --instance-of @class:word-processor
bun run query --has-predicate developed_by
bun run check-links     # HEAD-check wikipedia statement slugs
```

The pre-commit hook runs `bun run validate`. Fix errors before committing; do not use `--no-verify`.

## Adding content

**New class (clade):**
1. Add entity with `instance_of @meta:class`, `subclass_of @class:<parent>`, and a new id in the `class:` namespace.
2. Add `synapomorphy` statements for defining traits (string-valued, unsourced is fine for class entities).
3. Run `bun run tree` to verify placement.
4. Classes need at least 3 real instances before adding — see class curation rule above.

**New program entity:**
1. Add entity with `instance_of @class:<class>` and id in the appropriate namespace (`software:`, `format:`, etc.).
2. Every factual statement (`first_released`, `developed_by`, etc.) must have a `source` pointing to a record in `sources.jsonl`.
3. Add the source record first; reference by id.

**New predicate:**
1. Add to the relevant lens's `predicates.jsonl` with id, label, description, `value_type`, `domain`, `range`, `cardinality`, and `since_version`.
2. Consider whether an inverse predicate should also be added.
3. See predicate vocab governance above.

## Anti-confabulation

The validator enforces referential integrity and warns on missing sources. Do not invent release dates, author attributions, or lineage without a citable source. If you cannot find a Wikipedia article, use the unknown sentinel (`{"unknown": true}`) on the uncertain statement rather than omitting it or guessing.

## Status

**Phase 3.5** complete — pre-Phase-4 hardening: namespaced entity ids, supertype classes (technical-artifact, agent, collective), sentinel values, predicate governance schema fields, duplicate-id detection, alias resolution, deprecated predicate warnings, multi-class preferred-rank warnings.

Next: **Phase 4** — Wikidata ingest tool.
