# Write-Path Mock-Test Inventory (issue #404)

Audit date: 2026-07-14. Scope: every `__tests__/unit/` suite that replaces
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

## Known thin spots, accepted for now (not backfilled)

Ranked; revisit if the area churns.

1. `migration.test.ts` — the "recorded in `__migrations` → skipped/reverted
   next run" contract is proven by a self-consistent mock (the SELECT is
   stubbed with the name the test expects). The emitted SQL is asserted
   concretely, so MED. A SQLite MigrationRunner roundtrip would close it.
2. `entity-subscriber.test.ts` — `databaseEntity` before-image on UPDATE
   (pre-read row) is mock-fed; not asserted against a real UPDATE anywhere.
3. Pessimistic `PESSIMISTIC_READ` lock pass-through — only PESSIMISTIC_WRITE
   is integration-tested; SQLite cannot enforce row locks regardless.
4. `delete-operation.test.ts` — asserts a locally re-declared `buildDeleteSql`
   copy, not the shipped builder (false-confidence smell; the real delete path
   itself is covered by integration).
5. Tx-lifecycle subscriber events (`beforeTransactionCommit` order, rollback
   firing) — asserted only against mocked sessions.

## Defects surfaced by this sweep

- **#414** — core (non-buffer) `em.delete` cascade-delete children run outside
  the parent delete's transaction. SQLite: hard crash; PG/MySQL: children
  commit independently (data loss on outer rollback). Repro: `it.failing`
  tests in `integration/sqlite/core-cascade-write-path.test.ts` — remove
  `.failing` when fixing.
