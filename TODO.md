# TODO

Forward-looking work after Phase 4.0 (A–E) shipped the datascript-shaped redesign.

## Ongoing: snippet backfill (4.0.E continuation)

- 921 statements still need snippets. Drain the worklist via repeated `/propose-snippets N` → `bun run review-snippets` cycles. No code change required; this is editorial work.
- The worklist file (`.snippet-worklist.json`) is gitignored. Progress lives locally. If multi-machine drive becomes useful, decide on persistence (tracked branch, side repo, or just accept locality).
- 38 official-source statements use a crude HTML→plaintext extractor. Snippets there may need manual editing more often than wikipedia ones. Watch acceptance rate; consider a real readability extractor if quality is low.

## Sourceless triage (4.0.F candidate)

- 159 statements have no source at all. Reported by `bun run sourceless-report`. Triage paths:
  - For lenses with `source_required: false` (biology, folklore, mythology-demo) — these are *legal*, just unsourced. Decide whether to add interpretive/folkloric source records anyway for traceability.
  - For core (where `source_required: true` but the validator currently rules these warnings) — add wikipedia/official sources or strike the statement.
- Decision needed: should `source_required_violation` upgrade from warning to error after triage? That's a one-line change in `rules.ts`.

## Adversarial wave on the new pipeline (4.1)

Every prior phase's adversarial wave found bugs. The new pipeline has not been waved yet. Hypotheses worth probing:

- Closure helpers (subclassClosure, instanceClosure, aliasClosure) — write fixtures exercising deep chains, cycles, and self-references that didn't exist before.
- Negation-as-failure rules — write fixtures where the positive query returns empty for non-obvious reasons (e.g. case-sensitivity, predicate alias resolution).
- Query API ergonomics — `q()` accumulates subscriptions per call (note from store.ts); confirm no leak under repeated calls in long-running tools like the REPL.
- Snippet acceptance gate — verify it actually catches a mis-quoted snippet (test fixture: a worklist entry whose proposed_snippet is NOT in the fetched revision; reviewer's accept should refuse).

## Engine choice revisit (4.2 candidate)

`@thi.ng/rstream-query` is a reactive triple store, not a datalog engine. Limitations carried as TS post-processing:

- No native recursion (transitive closure done by iterating queries to fixpoint).
- No native aggregation (group-by done in TS).
- No native negation (positive query + TS filter).
- No CLJS-keyword friction (good), but query syntax is bespoke (not EDN), so the "rules are a portable spec" claim is weak.

Reassess if corpus growth makes TS post-processing slow, or if rule expressivity becomes a bottleneck. Alternatives: real datalog (custom evaluator over the existing EAV indices), `@thi.ng/datalog`-shaped library if one matures, or Cozo (out-of-process again, but more capable).

## Dead-rule cleanup (low priority)

Three Ascent rules became unreachable by construction in the new format: `dangling_extension`, `own_entity_extension`, `duplicate_entity_id`. They're not present in `rules.ts` (the port phase already dropped them). Sanity check: confirm no residual references in docs.

## Worklist file format hardening

`review-snippets.ts` does atomic tmpfile+rename writes. Parallel `/propose-snippets` subagents do read-modify-write via Edit with the unique stmt_id as anchor. Failure mode: two subagents win the same stmt_id race (unlikely — dispatch slices into disjoint batches). If it ever happens: add a file lock, or move the worklist to SQLite. Don't pre-build.

## Documentation polish

- CLAUDE.md now describes the new architecture but doesn't yet document the worklist workflow. Add a short subsection under "Snippets" once 4.0.E's drain has run a few rounds and the workflow has settled.
- README.md roadmap table still references "future phases" loosely. Replace with a pointer to this TODO.

## CI

Currently the pre-commit hook runs validate + test-fixtures. CI parity:

- Run validate + test-fixtures on push to master.
- Run `verify-snippets --source wikipedia` on a cadence (weekly?) to catch revision drift on cited articles. (When a wikipedia article gets edited and the cited revid is OLDER than current, the substring should still match the pinned revid — `verify-snippets` already pins via `oldid`. The risk is link rot or rare revid invalidation.)
