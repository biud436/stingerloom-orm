# Pre-Release Final Review (v0.3.0)

## Review Date: 2026-03-01

---

## 1. Test Status

### Passing Tests

| Category | Count | Status |
|----------|-------|--------|
| ORM unit tests | 131 suites | All passed |
| ORM integration tests (MySQL) | 14 suites, 182 tests | All passed |
| ORM total | **131 suites, 2,978 tests** | **0 failures** |
| nestjs-cats e2e | 23 tests | All passed |
| nestjs-blog e2e | 59 tests | All passed |
| nestjs-multitenant e2e | 33 tests | All passed |
| Example type check (tsc --noEmit) | 3 projects | All passed |

### Bugs Found and Fixed in This Session

| Bug | Cause | Commit |
|-----|-------|--------|
| `Column 'parentFk' specified twice` | Duplicate addition in INSERT/UPDATE SQL when `@Column` and `@ManyToOne joinColumn` have the same name | bc7c7cc |
| nestjs-cats e2e 3 failures | Tests expected `count`/`hasNext`/`cursor`, but actual API returns `total`/`hasNextPage`/`nextCursor` | This session |

### Tests Added in This Session

| File | Test Count | Content |
|------|-----------|---------|
| `__tests__/integration/p0-fk-object-assignment.test.ts` | 15 | P0 FK object assignment patterns (J-2, J-3, M-1, M-2, S-7) |

---

## 2. Test Scenarios Not Yet Automated

These are items from the P1-P3 scenarios in `docs/manual-testing-guide.md` that lack integration tests.

### P1 — Recommended to Automate Before Release

| ID | Scenario | Current Status | Notes |
|----|----------|---------------|-------|
| J-1 | Query immediately after entity creation | Partially covered in `crud-basic.test.ts` | Needs explicit save -> findOne round-trip verification |
| J-4 | save() return type | Unit tests only | Verify actual `EntityResult<T>` type in integration tests |
| J-5 | Query non-existent ID | Partially covered in `crud-basic.test.ts` | Explicit `null` return verification |
| J-6 | find() on empty table | Not covered | Verify empty array vs undefined return value |
| M-3 | OneToMany cascade insert | Covered in `relations-one-to-many.test.ts` | Complete |
| M-4 | Delete with FK constraint violation | Partially covered in `relations-one-to-many.test.ts` | Needs error message format verification |
| M-5 | Soft delete + relations | Covered in `soft-delete.test.ts` | Complete |
| M-6 | FK preservation during partial update | Not covered | **Important** — Verify whether existing FK is reset to null on save({ id, name }) |

### P2 — When Driver Changes

| ID | Scenario | Current Status | Notes |
|----|----------|---------------|-------|
| M-7 | Upsert | Covered in `upsert.test.ts` | Complete |
| S-9 | QueryBuilder SQL Injection | Unit only in `sql-injection.test.ts` | Verify actual DB parameter binding in integration tests |

### P3 — Infrastructure

| ID | Scenario | Current Status | Notes |
|----|----------|---------------|-------|
| S-1 | Transaction rollback | Not covered | Verify DB state restoration on mid-transaction error |
| S-2 | Concurrent save() | Not covered | Deadlock, data integrity |
| S-3 | Connection pool exhaustion | Not covered | Queuing/timeout when pool size exceeded |
| S-4 | Multi-tenancy concurrent access | Partially covered in `multi-tenancy-postgres.test.ts` | PostgreSQL only, concurrency not verified |
| S-5 | Lifecycle hooks with plain objects | Partially covered in `lifecycle-hooks.test.ts` | Verify difference between plain object and class instance |
| S-6 | EntitySubscriber event order | Covered in `entity-subscriber.test.ts` | Complete |
| S-8 | Large-scale pagination | Not covered | Verify cursor pagination with 1000+ records for missing/duplicate entries |

---

## 3. Areas Requiring Additional Testing

### 3-1. PostgreSQL Driver Integration Tests

Current integration tests are MySQL-based. The following items may behave differently on PostgreSQL.

| Item | MySQL | PostgreSQL | Risk Level |
|------|-------|-----------|-----------|
| INSERT return | `insertId` | `RETURNING` | High |
| ENUM type | String | `CREATE TYPE` | Medium |
| Schema-qualified identifiers | Not supported | `schema.table` | High |
| Upsert syntax | `ON DUPLICATE KEY` | `ON CONFLICT` | Medium |
| `SERIAL` vs `AUTO_INCREMENT` | `AUTO_INCREMENT` | `SERIAL` | High |

**Recommendation**: Add driver matrix tests that run the same scenarios as MySQL integration tests on PostgreSQL.

### 3-2. save() Return Type Consistency

`EntityManager.save()` returns `Promise<InstanceType<ClazzType<T>>>`, but `BaseRepository.save()` returns `Promise<EntityResult<T>>` (`T | T[] | undefined`). This inconsistency causes user confusion.

**Verification needed**:
- Are there cases where `BaseRepository.save()` actually returns an array?
- Can the return type be simplified to `Promise<T>`?

### 3-3. FK Preservation During Partial Update (M-6)

```typescript
const cat = await catRepo.save({ name: "Nabi", parent: owner });
// Then update only name
await catRepo.save({ id: cat.id, name: "NewName" });
// -> Is the owner FK preserved, or reset to null?
```

Currently, in the `save()` UPDATE path, `metadata.columns.map()` includes all columns in SET, so columns missing from `item` may be SET to `undefined`. Verification needed whether this behavior is intended.

### 3-4. Transaction Isolation (S-1)

```typescript
@Transactional()
async failingOperation() {
  await repo.save({ name: "A" });
  throw new Error("rollback!");
}
```

After the error, "A" should not exist in the DB. The rollback path of the `@Transactional` decorator is currently not verified in integration tests.

### 3-5. Concurrency Safety (S-2)

```typescript
await Promise.all([
  repo.save({ id: 1, name: "A" }),
  repo.save({ id: 1, name: "B" }),
]);
```

- Whether deadlock occurs
- Final data integrity (one of A or B)
- `@Version` optimistic locking behavior

### 3-6. Example e2e Test Status

| Example | e2e Tests | How to Run | Status |
|---------|-----------|-----------|--------|
| nestjs-cats | 23 tests | `INTEGRATION_TEST=true pnpm test:e2e` | All passed |
| nestjs-blog | 59 tests | `INTEGRATION_TEST=true pnpm test` | All passed |
| nestjs-multitenant | 33 tests | `INTEGRATION_TEST=true pnpm test:e2e` | All passed |

All 3 example project e2e tests confirmed passing (2026-03-01).

---

## 4. Security Review

| Item | Status | Notes |
|------|--------|-------|
| SQL Injection (4 drivers) | Audit complete (2026-02-27) | Unit coverage in `sql-injection.test.ts` |
| Parameter binding | Applied to all drivers | Uses `sql-template-tag` |
| Identifier escaping | Applied to all drivers | `escapeIdentifier()` / `wrapIdentifier()` |
| Tenant metadata isolation | Verified | `getAllInContext()` merges public+context only |
| AsyncLocalStorage concurrency | Verified | `resolveContext()` introduced, `setContext()` deprecated |

---

## 5. Required Pre-Release Checklist

- [x] All unit tests passed (1469)
- [x] All integration tests passed (1507)
- [x] nestjs-cats e2e all passed (23)
- [x] nestjs-blog e2e all passed (59)
- [x] nestjs-multitenant e2e all passed (33)
- [x] 3 example type checks passed
- [x] SQL Injection audit complete
- [x] P0 FK object assignment bug fixed and tests added
- [x] M-6 partial update FK preservation verified — bug fix + 10 integration tests (4a242e2)
- [x] S-1 transaction rollback integration tests — 8 integration tests (4a242e2)
- [x] PostgreSQL integration tests — 35 tests (CRUD/FK/M-6/Upsert/Transaction/Schema)
- [x] `BaseRepository.save()` return type cleanup — `EntityResult<T>` -> `InstanceType<ClazzType<T>>` (4a242e2)

---

## 6. Prioritized Roadmap

### Release Blockers (Required Before v0.1.0)

1. ~~**M-6 Partial Update FK Preservation**~~ — Fix complete. UPDATE path skips undefined columns, 10 integration tests added.

### Quick Follow-Up After Release (v0.1.1)

2. ~~**S-1 Transaction Rollback Integration Tests**~~ — Complete. 8 integration tests (manual rollback, savepoint, isolation levels)
3. ~~**PostgreSQL Integration Tests**~~ — Complete. 35 integration tests (SERIAL/RETURNING, FK, M-6, ON CONFLICT, transaction, schema-qualified)
4. ~~**`BaseRepository.save()` Return Type**~~ — Complete. `EntityResult<T>` -> `InstanceType<ClazzType<T>>` change

### Stabilization (v0.2.0)

5. **S-2 Concurrency** — Deadlock, optimistic locking
6. **S-3 Connection Pool Exhaustion** — Behavior when pool size exceeded
7. **S-8 Large-Scale Pagination** — Cursor missing/duplicate with 1000+ records
