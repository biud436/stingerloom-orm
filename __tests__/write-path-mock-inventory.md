# Write-Path Mock-Test Inventory (issue #404)

Audit date: 2026-07-14. Last updated: 2026-08-17 (third round — V4-T1-1
false-green honesty pass; see the bottom section).

Scope: every `__tests__/unit/` suite that replaces
`em.save` / `em.update` / `em.delete` / `em.query` / `em.transaction` (or the
`TransactionSessionManager`) with a mock AND asserts via `toHaveBeenCalled*`.
49 files matched; each was classified by what its assertions can actually
prove.

Assertion styles:

- **CALL_COUNT_ONLY** — asserts only that a mocked write fn was called (count
  / args). A silent data-loss bug passes.
- **SQL_STRING** — asserts the generated SQL text/params handed to a mocked
  session. Catches builder regressions, but the statement never executes, so
  semantic bugs (wrong row selected, misaligned params, transaction escape)
  pass.
- **BEHAVIOR** — asserts real logic output (metadata, state machines,
  deserialization). Fine as unit tests.

The structural conclusion of the 2026-07-03 UoW audit holds for the core
write path too: wherever a scenario existed ONLY as CALL_COUNT_ONLY /
SQL_STRING, real-SQL execution had never been verified — and backfilling
those spots immediately surfaced a live defect (#414).

## High-risk clusters and their disposition

| unit suite (cluster) | style | real-SQL coverage before | disposition |
|---|---|---|---|
| `update-many-sql-expression.test.ts` — raw `` sql`col + 1` `` in SET | SQL_STRING | NONE | backfilled: `integration/sqlite/update-many-sql-expression.test.ts` (3) — no defect |
| `cascade-handler.test.ts` — `cascadeDeleteOneToMany` single + multi-parent IN | CALL_COUNT_ONLY | NONE (non-buffer) | backfilled: `integration/sqlite/core-cascade-write-path.test.ts` — **defect found, #414** (child deletes escape the parent delete's transaction; SQLite nested-BEGIN crash, PG/MySQL non-atomic). Repros committed as `it.failing` |
| `cascade-handler.test.ts` — `cascadeSaveManyToOne` parent INSERT + child FK | CALL_COUNT_ONLY + in-memory FK | NONE (non-buffer) | backfilled: same file (1) — no defect |
| `buffer-plugin.test.ts` — `validateBeforeFlush` (throw, suppress-DB-work, happy path) | CALL_COUNT_ONLY | NONE | backfilled: `integration/sqlite/buffer-validate-before-flush.test.ts` (4) — no defect |
| `increment-decrement.test.ts` — negative / fractional `by`, zero-row WHERE | SQL_STRING (edges untested anywhere) | NONE for edges | backfilled: `integration/sqlite/usability-write-edges.test.ts` (4) — no defect |
| `upsert.test.ts` — `batchUpsert` null fallback for missing optional column | SQL_STRING (flattened params only) | NONE for heterogeneous rows | backfilled: same file (2) — no defect |
| `buffer-plugin.test.ts` — batchInsert MySQL `insertId + i` sequential PK writeback | CALL_COUNT_ONLY (mocked insertId) | NONE on real MySQL | backfilled: dual-driver `integration/buffer-plugin.test.ts` "batchInsert (multi-row INSERT)" — runs on real PG + MySQL in CI |

## Clusters already covered by real SQL (no action)

- **Buffer flush/cascade/identity-map** (`buffer-plugin.test.ts`, most
  describes): the 2026-07 batch A/B sweeps left 20 SQLite `buffer-*` suites +
  the dual-driver `buffer-plugin` file covering flush order, M2M pivot sync
  (tracked-parent add/remove and new-parent persist are both flush-asserted in
  `buffer-preview-parity`), orphan reparenting, batch events, naming-strategy
  tokens, nested savepoints, rollback restoration.
- **Batch operations / soft delete / upsert basics / insertManyAndReturn /
  pluck / findBy / aggregates**: dual-driver `batch-operations`, `soft-delete`,
  `upsert` + `sqlite/usability-methods`, `sqlite/write-path-parity`.
- **Lifecycle hooks / subscribers / entity events**: `sqlite/lifecycle-hooks-queries`
  asserts hook mutations reach the DB; dual-driver `lifecycle-hooks`,
  `entity-subscriber`. (The `em.on()` save-path insert/update events are
  DB-verified only via the subscriber equivalent — acceptable overlap.)
- **Transactions / connections / drivers / migrations plumbing**: unit mocks
  are appropriate (no persisted-data claim); real transaction semantics are
  covered by `sqlite/transactions`, `p3-transaction-rollback`.

## Second backfill round (2026-08-02) — former "accepted thin spots"

All five previously-accepted thin spots are closed:

1. `migration.test.ts` (record/skip/revert proven by a self-consistent
   SELECT stub) — backfilled:
   `integration/sqlite/migration-runner.test.ts` (8) drives
   runAll/runDown/revertLast/rollback/status from real `__migrations` rows.
   The unit suite keeps only dialect-shape assertions — no defect.
2. `entity-subscriber.test.ts` `databaseEntity` before-image (mock-fed
   pre-read) — backfilled:
   `integration/sqlite/entity-subscriber-session.test.ts` pins the snapshot
   to the real pre-update row (untouched columns included, consecutive
   updates) — no defect.
3. `PESSIMISTIC_READ` pass-through — backfilled: dual-driver
   `integration/pessimistic-read-lock.test.ts` (3) proves real PG/MySQL
   parse the suffix and that it is genuinely a SHARED lock (two overlapping
   transactions hold it on the same row) — no defect. Still unit-only:
   the NOWAIT / SKIP LOCKED **read** variants (`LOCK IN SHARE MODE NOWAIT`
   etc.) — accepted; revisit if lock-suffix code churns.
4. `delete-operation.test.ts` (locally re-declared `buildDeleteSql` copy) —
   copy deleted; `integration/sqlite/delete-operation.test.ts` (10) verifies
   the shipped builder. **The copy had drifted**: it dropped `null` criteria
   while the shipped resolver emits `IS NULL`, and it threw a plain Error
   where the shipped path throws DeleteWithoutConditionsError — the exact
   false-confidence failure mode this inventory exists to catch.
5. Tx-lifecycle subscriber events (dispatch tested by calling
   `notifyTransactionSubscribers` directly) — backfilled: the same
   `entity-subscriber-session` suite records all six hooks around a real
   commit and a real rollback (rollback case also proves the INSERT was
   discarded) — no defect.

Related (same round): the tenant M2M batched-load suite in
`unit/tenant-column-relations.test.ts` was un-xdescribe'd — its note
claimed MySQL/PG integration coverage that never existed — and mirrored on
real drivers in `integration/tenant-m2m.test.ts`.

## Defects surfaced by this sweep

- **#414** — core (non-buffer) `em.delete` cascade-delete children ran
  outside the parent delete's transaction. SQLite: hard crash; PG/MySQL:
  children committed independently (data loss on outer rollback).
  **Fixed by PR #416** (the delete transaction's session is published via
  `transactionStorage.run` so cascades join it). All 7 repro tests in
  `integration/sqlite/core-cascade-write-path.test.ts` are live (no
  `it.failing` remains), plus dual-driver
  `integration/cascade-delete-atomicity.test.ts` on real PG/MySQL.

## Third round (2026-08-17) — V4-T1-1 false-green pass

Four write-path thin spots and the false-green tests around them:

1. `cascade-handler.test.ts` — `cascadeSaveOneToMany` asserted that
   `ctx.saveWithSession` was called, never that the parent's session was the
   argument (the save-direction twin of #414). Backfilled in
   `integration/sqlite/core-cascade-write-path.test.ts` (3): FK write, child
   INSERT failure rolling the parent back, subscriber failure rolling the
   children back. All three fail when the session forwarding is removed —
   **no defect in the shipped path**; the unit suite now also pins the
   session argument.
2. `transaction-options.test.ts` / `transaction-propagation.test.ts` —
   savepoint creation and `rollbackTo` were only counted, never correlated.
   Correlation is now asserted in both paths, and the cross-instance case
   surfaced a **real defect**: `TransactionRunner`'s savepoint counter was
   per-instance, so two EntityManagers sharing an ambient session both emitted
   `sp_em_1` (the later SAVEPOINT shadows the earlier, so the outer
   `ROLLBACK TO` keeps work it meant to undo). Counter is now process-wide.
3. `write-buffer-flush-optimization.test.ts` — re-declared `hasQueuedWork()`
   inside the test file and asserted its own closure (same failure mode as the
   `buildDeleteSql` copy above). Rewritten against `size()` / `preview()` /
   `flush()`.
4. merge() + `@Version` — `trackAsMergedDetached` seeds the snapshot with a
   Symbol sentinel, so `FlushExecutor.ensureVersionIncrement` can never match
   the old version and skips its manual bump. The write path's own write-back
   covers it; pinned by `integration/sqlite/buffer-merge-version.test.ts` and
   noted in the method's doc comment — no defect.

Test-honesty fixes in the same round (no write-path claim): STI delete guards
(`if (row)` around every assertion) replaced with owned fixtures plus a
sibling-survives case; the schema-diff rename test split into detection and
non-detection cases (it previously accepted both); `select-query-builder-exists`
floating promise awaited; eight assertion-less `explain-query-handler` cases
given SQL contracts; the STI "via buffer" seed routed through the buffer;
`composite-pk` RETURNING guard added; two PG-only `sql-craft-patterns` cases
turned from early `return` into real skips; the 19 `STRESS_TEST` tests wired to
`pnpm test:stress` and a CI job.
