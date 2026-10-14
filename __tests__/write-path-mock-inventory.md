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
  covered by `sqlite/transactions`, `p3-transaction-rollback`, and — for
  isolation levels, propagation, `@Transactional` and the read path's
  BEGIN — dual-driver `transaction-contract-real` (see the fourth round).

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
   transactions hold it on the same row) — no defect. The NOWAIT / SKIP
   LOCKED **read** variants, left unit-only here, are covered since the
   fifth round — and were broken on MySQL 8 (see there).
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

## Fourth round (2026-10-14) — transaction contract on real PG/MySQL

`transaction-options`, `transaction-propagation`, `transactional` and
`read-only-optimization` assert almost entirely through call counts on a
mocked session, and no integration file used `isolationLevel`,
`propagation` or `@Transactional`. The statements that decide the contract
(BEGIN / START TRANSACTION, SET TRANSACTION, SAVEPOINT, SET LOCAL) are sent
by the connectors straight to the driver connection, so the ORM's query log
never shows them either.

Backfilled in dual-driver `integration/transaction-contract-real.test.ts`,
which records statements at the driver's `query()` and reads the outcome
from the server:

1. Isolation — each of the four levels is the level the transaction runs
   at (PostgreSQL: `SHOW transaction_isolation`; MySQL/MariaDB report only
   the session default, so the level is classified by behavior against a
   second connection: shared-lock block, snapshot, dirty read). No option
   runs at READ COMMITTED: PostgreSQL sends no SET, MySQL sends one before
   START TRANSACTION.
2. REQUIRES_NEW — a different backend / connection id, its commit survives
   the outer rollback, its failure leaves the outer transaction to commit,
   and it does not see the outer transaction's uncommitted rows. REQUIRED
   joins: same connection, one outcome.
3. NESTED — SAVEPOINT and ROLLBACK TO on the outer connection, outer writes
   before and after kept; an outer rollback discards a successful nested
   block; with no outer transaction it opens its own.
4. `@Transactional` — the same three propagations plus the decorator's
   isolation level, on a real class.
5. Reads — `find()` sends no BEGIN; a `timeout` read opens one on
   PostgreSQL only; a search_path tenant read runs BEGIN + `SET LOCAL
   search_path` and returns the tenant schema's rows.

## Fifth round (2026-10-14) — dialect branches on real PG/MySQL

Dialect-specific SQL that only unit string comparisons or SQLite had run.
Each item's SQL differs per dialect, so a syntax error or a wrong spelling
could pass CI:

1. Row locks, index hints, CTEs, DISTINCT — dual-driver
   `integration/sqb-dialect-suffix-dual.test.ts`: NOWAIT fails at once and
   SKIP LOCKED skips a held row, through the query builder and
   `find({ lock })`; index hints reach MySQL and are left out on PostgreSQL;
   `hint()`, `with()` / `withRecursive()`, `setDistinct()`. **Defect found:**
   the shared NOWAIT / SKIP LOCKED variants sent `LOCK IN SHARE MODE NOWAIT`,
   a syntax error on MySQL 8 — now `FOR SHARE ...` there and
   `LOCK IN SHARE MODE ...` on MariaDB.
2. `MigrationRunner` — dual-driver `integration/migration-runner-real.test.ts`
   (pools of four and one): order, records, hooks, rollback, a failing
   migration, and the advisory lock against a second runner and from outside
   the pool. **Defect found:** the session lock was taken and released through
   the pool, so it could outlive the run and a second runner in the process
   could take it on the holding session — the lock connection is now held
   until the release.
3. `synchronize: "safe"` / `"dry-run"` and `@FullTextIndex` — dual-driver
   `integration/schema-sync-modes-dual.test.ts` — no defect.
4. Query builder productivity methods — `integration/sqlite/select-query-builder-productivity.test.ts`
   (`applyScope`, IN / EXISTS subqueries incl. correlated, `orWhereGroup`,
   `take`, `getOneOrFail`, `whereHas` / `whereNotHas`, `getManyAndCount`)
   checks rows instead of SQL — no defect.
5. A column type registered with `em.registerColumnType()` —
   `integration/sqlite/custom-column-type.test.ts`: DDL type and transformer
   both ways — no defect; the method is now documented as process-wide.

Already covered before this round and not repeated: INSERT builder conflict
actions (`insert-query-builder-on-conflict`), `insertIgnore` /
`createUpdateBuilder` (upsert and tenant suites), uuid reboot diff
(`uuid-column-schema-sync`), `em.clear()` (`clear-contract`).
