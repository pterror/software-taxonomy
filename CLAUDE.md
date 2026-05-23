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

Sentinels count toward **MAX** cardinality but **NOT MIN**. A `1..1` required predicate with only `{"unknown": true}` is a cardinality error ("0 real values found, 1 required"). Sentinels assert presence, not content — use them for "known unknown" gaps, not to satisfy required fields.

## Conventions

- Entity ids: namespaced form `<type>:<slug>`, pattern `^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$` — exactly one colon, non-empty parts on each side. No bare ids, no double colons.
- Predicate ids: snake_case, `^[a-z][a-z0-9_]*$`.
- Entity refs in statement values: `@<namespace>:<slug>` prefix.
- Source ids in statements: must exist in `sources.jsonl` in any loaded lens.
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

- **To add a predicate**: open a PR adding it to the relevant lens's `predicates.jsonl` with full `value_type`, `domain`, `range`, `cardinality` constraints, and a `since_version` tag. Consider whether an inverse is needed.
- **To deprecate a predicate**: set `deprecated: true` and document the successor in the predicate's `description`. The validator will warn on all uses.
- **To merge near-duplicates**: set `alias_of` on the deprecated predicate pointing to the canonical. The validator resolves constraints from the canonical and logs an info message on use.
- **`expect_preferred` flag**: set `expect_preferred: false` on predicates where multiple parallel current values are the norm and designating a "primary" would be wrong (e.g. `written_in`, `runs_on`, `licensed_under`, `principal_author`, `synapomorphy`, `aspect_of`). The `no-preferred-rank` validator warning is suppressed for predicates with this flag. Default is `true`.

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

## Cross-lens entity extension (overlay model)

A lens's `entities.jsonl` may contain two kinds of records:

```jsonc
// Definition record — owns the entity; exactly one definition per id across all lenses
{
  "id": "software:microsoft-word",
  "labels": {"en": "Microsoft Word"},
  "statements": { ... }
}

// Extension record — adds statements to an entity defined in another lens
{
  "extends": "@software:microsoft-word",
  "statements": {
    "influenced_by": [{"value": "@software:wordperfect"}]
  }
}
```

**Rules:**
- A definition record has `id` (no `extends`). Exactly one definition per id globally — duplicate definition is an error.
- An extension record has `extends` (no `id`, no `labels`, no `description`, no `aliases`). It targets a definition that must exist in another lens.
- A lens cannot extend an entity it owns (`own-entity-extension` error — use the definition record instead).
- Extension statements are tagged with `origin_lens` of the extending lens. Visible in `query --entity <id> --format text`.
- `source_required` is evaluated against the **owning** lens's manifest. A biology overlay (`source_required: false`) extending a core entity (`source_required: true`) must still source every statement it adds. See "Temporal modeling" section for the `kind: "interpretive"` escape hatch.

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

**Phase 3.8** complete — validator structural refactor + qualifier completeness + temporal corpus completion:
- Extracted `validateStatementEntry` as a single shared function (definition and extension paths unified — no more behavioral drift).
- Qualifier shape validation now runs on **all** statements including `rank: deprecated` — previously silent.
- Multi-preferred-rank check now uses MERGED statements across all lenses (catches cross-lens duplicates).
- Qualifier values now support entity refs (`@namespace:id`) and sentinels (`{unknown:true}`, `{novalue:true}`); schema updated accordingly.
- New validator warnings: `deprecated-no-end-time`, `end-without-start`, `no-preferred-rank` (with `expect_preferred: false` predicate flag to suppress).
- `kind: "interpretive"` sources now require `last_verified` (same strictness as `official`).
- `expect_preferred: false` set on `written_in`, `runs_on`, `licensed_under`, `principal_author`, `synapomorphy`, `aspect_of`.
- Temporal completions: vim (Christian Brabandt as successor, 2023-08), sublime-text (jon-skinner → sublime-hq, 2014), vscode (stray `note` qualifier removed).
- PostgreSQL concept split: `@class:postgres` + `@software:berkeley-postgres` (Stonebraker 1986-1994) + temporal `developed_by` on `@software:postgresql`.
- Redundant `instance_of` removed from cron and make implementations (reachable via subclass_of chain).
- Loader private field renamed from `_origin_lens` to `__loader_origin_lens` (double-underscore = loader-injected, not a data field).

**Phase 3.7** complete — validator parity + temporal discipline + retroactive fixes:
- Extension records now validate at full parity with definition records (schema, domain, range, qualifier, cross-lens, source-required using owner policy).
- `source_required` for extensions uses the OWNING lens's policy, not the extending lens's.
- `"interpretive"` added to source `kind` enum for biology/interpretive warrants.
- Multi-preferred-rank check generalized to all predicates (not just `instance_of`).
- cron and make split into concept classes + instance entities (`@class:cron`, `@class:make`).
- 14 retroactive temporal fixes from audit wave 2 (nginx, mysql, openrc, travis-ci, autogpt, langchain, cmake, git, postgresql, caddy + substrates).
- 14 programs audited and fixed in wave 3 (sendmail, gimp, vim, jenkins, adobe-photoshop, mariadb, mongodb, redis, elasticsearch, mercurial, wordperfect, emacs, systemd + substrates).
- 5 duplicate source records deduped (cmake, bazel, ninja, kitware, postgresql).
- Tooling: `bun run tree` default root fixed to `@class:software`; duplicate source id detection; single lens load per validate run.

**Phase 3.6** complete — hardening pass two: cross-lens entity extension records (overlay model), sentinel cardinality semantics (count toward max, not min), tightened id pattern, multi-preferred-instance-of error, qualifier validation, source schema strictness (revid required for wikipedia, last_verified required for official), factual error corrections in seed corpus, predicate relocation (fork/lineage predicates to core), and tool improvements (tree --lens dependent loading, query --lens-family default action, structured cycle errors).

Next: **Phase 3.9** — Biology overlay substrate (~26 organ/metabolism class entities, organ vs feature naming, biology predicate expansion).
