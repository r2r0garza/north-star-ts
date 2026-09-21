# PR100: Measured index import lookup optimization

> Status: **DEFERRED**. Optimize `what_imports` only after representative measurements show the JSON expression scan is material.

## Goal

Keep importer lookup responsive for genuinely large indexes without adding schema and write-path complexity prematurely.

## Activation condition

Collect query-plan and latency data on representative large workspaces. Activate when `findImportsOf()` is observably slow or its scan is a material share of index-query latency.

## Required plan/analysis pass

Measure import-row cardinality, inspect `EXPLAIN QUERY PLAN`, and compare an SQLite expression index on `json_extract(detail, '$.module')` against a dedicated stored `module` column. Include migration cost, index size, write overhead, malformed/legacy detail handling, and downgrade/rebuild behavior. Prefer the smallest design that meets the measured need.

## Acceptance

- The chosen query uses an index for workspace, import kind, and module matching as demonstrated by the query plan.
- Results, ordering, limits, and case semantics remain unchanged.
- Existing indexed databases migrate safely and newly extracted symbols populate any new representation consistently.
- Benchmarks or repeatable fixtures demonstrate a meaningful improvement at the target scale.

## Likely files

- `src/main/db/schema.ts`
- `src/main/db/repositories/index-symbols.ts`
- Index symbol write/extraction paths and SQLite-backed tests

## Out of scope

- Redesigning the entire symbol index.
- Optimization without a representative measurement.
