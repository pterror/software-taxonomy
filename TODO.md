# Roadmap

## What this is

"A general knowledge graph of software, where taxonomy is a derived view."
Cladistic taxonomy of software treated as living organisms — a structured,
queryable corpus that grows over many critique rounds. Taxonomy is derived,
not fixed.

## Currently shipped

Phase 1–3: corpus seed, lens architecture, namespaced entity IDs, multi-lens
validation.

Phase 4.0 (A–E): full pipeline rewrite. In-process triplestore replacing the
Ascent subprocess; entity-per-file format; snippet-as-anti-confabulation
primitive introduced and wired into the acceptance gate. 922→921 snippets
drained so far.

## Active drain (4.0.E continuation)

Snippet backfill via repeated `/propose-snippets N` → `bun run review-snippets`
cycles. 921 statements still need snippets. The worklist (`.snippet-worklist.json`)
is gitignored; progress is local. 38 official-source statements use crude
HTML→plaintext extraction — watch acceptance rate, consider a real readability
extractor if quality is low.

Sourceless triage: 159 statements flagged by `bun run sourceless-report`. For
lenses with `source_required: false`, decide whether interpretive sources are
worth adding anyway. For core, add sources or strike the statement. Decision
needed: should `source_required_violation` upgrade from warning to error once
triage is done? One-line change in `rules.ts`.

## Near-term phases (artifact-stated)

### 4.1 — Biology overlay substrate (next)

From CLAUDE.md Status. ~26 organ/metabolism class entities. Resolve organ vs
feature naming convention (e.g. "memory" as organ or feature?). Expand biology
predicates: metabolism, reproduction, niche, lifecycle. The first overlay that
meaningfully exercises the lens system beyond the demo.

### 4.2 — Adversarial wave on new pipeline (parallel)

Every prior phase's wave found bugs; the new pipeline hasn't been waved yet.
Targets: closure helpers under deep chains and cycles; negation-as-failure rules
under predicate-alias resolution; `q()` subscription accumulation in long-running
REPL sessions; snippet acceptance gate against mis-quoted snippets (test fixture:
proposed snippet NOT present in the fetched revision; accept should refuse).

### 4.3 — Engine revisit (conditional, performance-gated)

`@thi.ng/rstream-query` has no native recursion, aggregation, or negation;
current workarounds are TS post-processing. Reassess only if corpus growth makes
this slow, or if rule expressivity becomes a bottleneck. Alternatives: custom
datalog evaluator over existing EAV indices, `@thi.ng/datalog` if it matures,
or Cozo. Don't pre-build.

### 5 — Wikidata ingest

`@wd:` namespace already registered. Build reconciliation (`@wd:Qxxxxx` ↔
`@software:slug`). Bulk import select claims. Preserve revid/snapshot pinning
for source provenance — the lesson from 4.0 is that pinned source is the trust
primitive.

### 6 — Bulk LLM-assisted ingest

Statement extraction at scale from documentation and articles. Per-source rather
than per-statement (4.0.E's subagent pipeline was the per-statement prototype;
6 generalizes). Snippet generation in the same pass. Human review remains.

### 7 — Browseable site

Currently undesigned; needs its own design session. Likely: static site
(VitePress matches the rest of the rhi ecosystem), query UI by lens / predicate /
class hierarchy, derived tree views (`bun run tree` is the prototype), snippet
and source display alongside every claim so the anti-confabulation is visible to
readers. SvelteKit if interactivity demands it.

## Speculative — past Phase 7

### 8 — Comparative analysis (speculation)

Inter-software diff. Cladistic distance metrics over predicate/value sets. Where
the biology metaphor starts paying off in derived insight rather than just
naming: "X and Y share these metabolism predicates → close kin."

### 9 — Public API (speculation)

Read-only query endpoint. Datalog over HTTP or something simpler. Federation
hooks for other authors to consume the corpus programmatically.

### 10 — Federated knowledge graphs (speculation)

This corpus + Wikidata + third-party overlays. Snippet-as-anti-confabulation is
the trust primitive across federation boundaries — the original reason 4.0 made
snippets a first-class primitive.

### 11+ — Cladistic exposition (speculation)

The original goal restated: software as biological organisms with evolutionary
history. At sufficient corpus density the cladistic story becomes writable. The
artifact is essay, book, or interactive work — not the corpus itself. Corpus →
exposition. Phases 4–10 are the corpus phase; 11+ is the artifact phase.

## End condition (speculation)

Three plausible terminations:

1. Cladistic-exposition ships. The corpus was always the means; the essay is the
   end. Maintenance after that is library-of-record only.
2. Representative coverage reached (~10k entities?). Site live; maintenance only.
3. Never. The project IS the corpus, perpetually curated.

The README intro ("grows over many critique rounds") leans toward #3 as the
default, with #1 as the artifact if motivation persists.

## Tactical follow-ups (background, not phase-gated)

**Dead-rule cleanup.** Three Ascent rules became unreachable in the new format
(`dangling_extension`, `own_entity_extension`, `duplicate_entity_id`). Not
present in `rules.ts`. Sanity-check: confirm no residual references in docs.

**Worklist file format hardening.** `review-snippets.ts` does atomic
tmpfile+rename writes; parallel `/propose-snippets` subagents do read-modify-write
using stmt_id as anchor. Failure mode is a same-id race (unlikely given disjoint
dispatch batches). If it happens: add a file lock or move to SQLite. Don't
pre-build.

**Documentation polish.** CLAUDE.md describes the new architecture but doesn't
yet document the worklist workflow; add a short subsection under "Snippets" once
4.0.E's drain has run a few rounds. README.md roadmap table has a numbering
inconsistency ("4.1 next: Biology", then a bare "4" for Wikidata); reconcile
README numbering with this doc in a docs-polish pass.

**CI parity.** Pre-commit runs validate + test-fixtures; push to master should
too. Add a scheduled run of `verify-snippets --source wikipedia` (weekly?) to
catch revision drift on cited articles.

## Open questions from the founding session

Surfaced by mining session `b933d7e2` (the founding conversation) — flagged
there, unresolved, not yet tracked.

**Specs / standards / protocols as first-class entities.** HTTP, JSON, PDF
"aren't software in core's typology and do have release dates and dependencies;
however they *are* specs/standards/protocols." Either widen `@software:` to
cover them, or open a sibling namespace (`@spec:`, `@protocol:`). Affects how
`implements` / `conforms_to` relate ingested software to the standards
underneath. Decision needed before bulk ingest (phases 5–6) touches anything
spec-shaped.

**Temporal `developed_by` semantics.** The nginx case: Sysoev is the original
developer, F5 is the current owner. Both are true at different times. Today's
schema flattens them. Options: a time-bounded predicate variant
(`developed_by_during`), a separate `originally_developed_by` predicate, or
EAV values that carry their own date range. Not urgent; will bite at scale.

**Lore / folklore lens.** Software mythology as its own lens: Mythical
Man-Month, Worse Is Better, Zawinski's Law, founder myths, war stories. A
companion to `worldbuilding.*` but rooted in real industry folklore rather
than fiction. The `mythology-demo` entity exists as a seed.

**Worldbuilding sub-lens namespaces.** `worldbuilding` was always meant as a
namespace of distinct universe lenses, not a single flat overlay:
`worldbuilding.scifi`, `worldbuilding.fantasy`, `worldbuilding.grimdark`,
`worldbuilding.space-opera`, `worldbuilding.mythology`. Lens architecture
already supports namespacing; what's missing is the convention + a seeded
example beyond mythology.

**Adversarial scalability subagent.** Distinct from 4.2's correctness wave: a
standing agent whose job is to stress-test how the corpus / pipeline behaves at
10×, 100× current size. Useful before phase 6 (bulk LLM ingest) commits to a
representation that doesn't scale.
