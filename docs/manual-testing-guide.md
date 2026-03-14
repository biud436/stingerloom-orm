# Additional Test Scenarios Guide

Although 1,400+ unit tests + integration tests + 59 e2e tests all pass, a ManyToOne FK save bug was discovered in actual usage. This document identifies blind spots that existing automated tests failed to cover and provides a list of scenarios to automate as integration tests in the future.

## Blind Spots in Existing Tests

### 1. Unit Tests Verify Implementation, Not the User Contract

Mock-based unit tests only check whether SQL was generated. Actual DB round-trips (save -> findOne) can only be verified in integration tests.

```typescript
// What unit tests verify: "Does the SQL contain owner_id?"
expect(executedSql).toContain("owner_id");

// What integration tests should verify: "Is the owner attached when read back from DB?"
const cat = await repo.findOne({ where: { id: 1 }, relations: ["owner"] });
expect(cat.owner.id).toBe(7);
```

### 2. Tests Use Only "Insider" Patterns

Existing tests use `parentFk: parent.id` to directly set FK column values. However, users who read the documentation use the **relation object assignment** pattern like `cat.owner = ownerEntity`. This pattern was absent from tests, which led to the bug going undetected.

### 3. Return Type (Resolved)

Previously, `BaseRepository.save()` returned `EntityResult<T>` (`T | T[] | undefined`), requiring defensive `Array.isArray()` checks. This has been fixed: `find()` now returns `T[]` and `save()` returns `T`, so no defensive wrapping is needed.

```typescript
// Before (old API — no longer needed)
const result = await repo.save(cat);
const saved = Array.isArray(result) ? result[0] : result;

// After (current API)
const saved = await repo.save(cat);   // returns T directly
const users = await repo.find();       // returns T[] directly
```

---

## Junior Scenarios — Basic CRUD and Relation Setup

> Scenarios that should work when code is written in the most intuitive way after reading the documentation.

### J-1. Query Immediately After Entity Creation

```typescript
const owner = await ownerRepo.save({ name: "Alice" });
const found = await ownerRepo.findOne({ where: { id: owner.id } });
```

| #   | Check Item                                | Pass | Notes               |
| --- | ----------------------------------------- | ---- | ------------------- |
| 1   | Does `owner` contain an `id`?             |      | AUTO_INCREMENT return |
| 2   | Is `found` not `null`?                    |      |                     |
| 3   | Is `found.name === "Alice"`?              |      |                     |

### J-2. ManyToOne Relation — Object Assignment Then Save

The first pattern users will try after seeing `@ManyToOne` in the docs:

```typescript
const owner = await ownerRepo.save({ name: "Alice" });
const cat = { name: "Nabi", owner: owner }; // <- Direct relation object assignment
const saved = await catRepo.save(cat);
```

| #   | Check Item                                                                             | Pass | Notes             |
| --- | -------------------------------------------------------------------------------------- | ---- | ----------------- |
| 1   | Is `saved` returned without errors?                                                   |      |                   |
| 2   | Does the cat's `owner_id` in the DB match `owner.id`?                                 |      | Verify FK column directly |
| 3   | When queried with `findOne({ where: { id: saved.id } })`, is `cat.owner.name === "Alice"`? |      | Eager loading     |

### J-3. ManyToOne Relation — Direct FK Column Specification

When the FK field is declared directly with `@Column()`:

```typescript
const owner = await ownerRepo.save({ name: "Alice" });
const cat = await catRepo.save({ name: "Nabi", ownerFk: owner.id });
```

| #   | Check Item                                  | Pass | Notes          |
| --- | ------------------------------------------- | ---- | -------------- |
| 1   | Is the FK column included in the INSERT SQL? |      |                |
| 2   | Is the owner relation loaded on query?       |      | When eager     |

### J-4. Using save() Return Value

```typescript
const result = await catRepo.save({ name: "Nabi" });
console.log(result.name); // Should work directly — no defensive checks needed
```

| #   | Check Item                                                       | Pass | Notes                     |
| --- | ---------------------------------------------------------------- | ---- | ------------------------- |
| 1   | Is `result` a single object (not an array)?                      |      | `save()` returns `T`      |
| 2   | Can you access properties directly without `Array.isArray(result)`? |      | Yes, fixed in DX update   |
| 3   | Does `findOne()` always return a single object or `null`?        |      | `T \| null` type          |

### J-5. Query Non-Existent ID

```typescript
const cat = await catRepo.findOne({ where: { id: 999999 } });
```

| #   | Check Item                              | Pass | Notes           |
| --- | --------------------------------------- | ---- | --------------- |
| 1   | Is `cat` `null`? (not an error)         |      |                 |
| 2   | Is it null, not undefined?              |      | Documentation contract |

### J-6. find() on Empty Table

```typescript
const cats = await catRepo.find({});
```

| #   | Check Item                               | Pass | Notes             |
| --- | ---------------------------------------- | ---- | ----------------- |
| 1   | Does it return without errors?           |      |                   |
| 2   | Is it an empty array `[]`, not `undefined`? |      | `find()` returns `T[]` |

---

## Middle Scenarios — Relation Changes, Deletion, Transactions

> Common patterns in production: relation modification, deletion, and transactions.

### M-1. ManyToOne Relation Change (Parent Reassignment)

```typescript
const owner1 = await ownerRepo.save({ name: "Alice" });
const owner2 = await ownerRepo.save({ name: "Bob" });
const cat = await catRepo.save({ name: "Nabi", owner: owner1 });

// Change owner
cat.owner = owner2;
await catRepo.save(cat);
```

| #   | Check Item                                                     | Pass | Notes                 |
| --- | -------------------------------------------------------------- | ---- | --------------------- |
| 1   | Has the cat's `owner_id` in the DB changed to `owner2.id`?    |      |                       |
| 2   | Has the cat been removed from the previous owner's (`owner1`) cats list? |      | `relations: ["cats"]` |
| 3   | Has the cat been added to the new owner's (`owner2`) cats list? |      |                       |

### M-2. ManyToOne Relation Release (Null Assignment)

```typescript
cat.owner = null;
await catRepo.save(cat);
```

| #   | Check Item                                  | Pass | Notes             |
| --- | ------------------------------------------- | ---- | ----------------- |
| 1   | Is the cat's `owner_id` `NULL` in the DB?  |      |                   |
| 2   | Is `cat.owner` `null` on query?             |      | Eager loading result |
| 3   | Has the cat disappeared from the previous owner's cats list? |      |                   |

### M-3. OneToMany + Cascade Insert

```typescript
const owner = await ownerRepo.save({
  name: "Alice",
  cats: [{ name: "Nabi" }, { name: "Cheese" }],
});
```

| #   | Check Item                                              | Pass | Notes      |
| --- | ------------------------------------------------------- | ---- | ---------- |
| 1   | Was the owner saved successfully?                       |      |            |
| 2   | Were both cats created?                                 |      |            |
| 3   | Does each cat's `owner_id` match owner.id?              |      | FK check   |
| 4   | Are cats loaded when queried with `relations: ["cats"]`? |      |            |

### M-4. Deletion — Deleting an Entity with Relations

```typescript
// What happens when deleting a parent that has children?
await ownerRepo.delete({ id: owner.id });
```

| #   | Check Item                                        | Pass | Notes              |
| --- | ------------------------------------------------- | ---- | ------------------ |
| 1   | Does a FK constraint violation error occur?       |      | Without cascade    |
| 2   | Is the error message understandable?              |      | OrmError format    |
| 3   | Does deleting children first then parent succeed? |      |                    |

### M-5. Soft Delete + Relations

```typescript
await catRepo.softDelete({ id: cat.id });

const found = await catRepo.findOne({ where: { id: cat.id } });
const foundWithDeleted = await catRepo.findOne({
  where: { id: cat.id },
  withDeleted: true,
});
```

| #   | Check Item                                     | Pass | Notes                |
| --- | ---------------------------------------------- | ---- | -------------------- |
| 1   | Is `found` `null`?                             |      | Soft deleted         |
| 2   | Does `foundWithDeleted` exist?                 |      | `withDeleted: true`  |
| 3   | Is `foundWithDeleted.deletedAt` a date value?  |      | `@DeletedAt`         |
| 4   | Is normal query possible after restore?        |      |                      |

### M-6. Update — Partial Update

```typescript
const cat = await catRepo.findOne({ where: { id: 1 } });
await catRepo.save({ id: cat.id, name: "NewName" });
// Are other fields (owner, etc.) preserved?
```

| #   | Check Item                                       | Pass | Notes                           |
| --- | ------------------------------------------------ | ---- | ------------------------------- |
| 1   | Is only `name` changed while other fields are preserved? |      | Partial update               |
| 2   | Is the `owner` relation preserved?               |      | FK not reset to null            |

### M-7. Upsert

```typescript
await catRepo.upsert({ name: "Nabi", age: 3 }, { conflictColumns: ["name"] });
```

| #   | Check Item                                     | Pass | Notes         |
| --- | ---------------------------------------------- | ---- | ------------- |
| 1   | Is INSERT performed on first execution?        |      |               |
| 2   | Is UPDATE performed on re-execution with same name? |      | ON CONFLICT   |
| 3   | Is the age value updated on conflict?          |      |               |

### M-8. Batch Operations

```typescript
const cats = await catRepo.insertMany([
  { name: "A" },
  { name: "B" },
  { name: "C" },
]);
```

| #   | Check Item                                            | Pass | Notes           |
| --- | ----------------------------------------------------- | ---- | --------------- |
| 1   | Were all 3 records inserted?                          |      | `affected: 3`   |
| 2   | Can batch delete with `deleteMany([id1, id2])`?       |      |                 |
| 3   | If one fails in the middle, does the entire operation roll back? |      | Transaction     |

---

## Senior Scenarios — Concurrency, Infrastructure, Edge Cases

> Production environment scenarios involving concurrency, connection pools, and multi-tenancy.

### S-1. Rollback on Mid-Transaction Error

```typescript
@Transactional()
async transferOwnership(catId: number, newOwnerId: number) {
  const cat = await catRepo.findOne({ where: { id: catId } });
  cat.owner = newOwner;
  await catRepo.save(cat);

  throw new Error("Intentional error"); // <- Is this rolled back?
}
```

| #   | Check Item                                                    | Pass | Notes          |
| --- | ------------------------------------------------------------- | ---- | -------------- |
| 1   | After the error, is the cat's owner preserved at its original value? |      | Direct DB check |
| 2   | When queried outside the transaction, are there no changes?   |      | ROLLBACK       |

### S-2. Concurrent save() Calls

```typescript
// Concurrent updates on the same entity
await Promise.all([
  catRepo.save({ id: 1, name: "A" }),
  catRepo.save({ id: 1, name: "B" }),
]);
```

| #   | Check Item                                                        | Pass | Notes                |
| --- | ----------------------------------------------------------------- | ---- | -------------------- |
| 1   | Does it complete without errors?                                  |      | Deadlock check       |
| 2   | Is the final value one of "A" or "B"? (no data corruption)       |      |                      |
| 3   | Does optimistic locking work with @Version?                       |      | OptimisticLockError  |

### S-3. Connection Pool Exhaustion

```typescript
// More concurrent requests than pool size (default 10)
const promises = Array.from({ length: 20 }, (_, i) =>
  catRepo.save({ name: `Cat_${i}` }),
);
await Promise.all(promises);
```

| #   | Check Item                                         | Pass | Notes                 |
| --- | -------------------------------------------------- | ---- | --------------------- |
| 1   | Do all requests complete? (queuing)                |      | Timeout check         |
| 2   | If timeout error occurs, is the message clear?     |      |                       |
| 3   | Does the pool recover to normal?                   |      | Subsequent request success |

### S-4. Multi-Tenancy Concurrent Access

```typescript
await Promise.all([
  MetadataContext.run("tenant_a", async () => {
    await catRepo.save({ name: "Tenant A Cat" });
  }),
  MetadataContext.run("tenant_b", async () => {
    await catRepo.save({ name: "Tenant B Cat" });
  }),
]);
```

| #   | Check Item                                                          | Pass | Notes                |
| --- | ------------------------------------------------------------------- | ---- | -------------------- |
| 1   | Is each tenant's data stored only in the corresponding schema?      |      | Cross-contamination check |
| 2   | Is the other tenant's data not queryable?                           |      | Isolation            |
| 3   | Do AsyncLocalStorage contexts not mix during concurrent execution?  |      |                      |

### S-5. Lifecycle Hooks — Plain Object Literals

```typescript
// Does @BeforeInsert work on a plain object, not an Entity class instance?
const cat = { name: "Nabi" }; // <- Not new Cat()
await catRepo.save(cat);
```

| #   | Check Item                                             | Pass | Notes                  |
| --- | ------------------------------------------------------ | ---- | ---------------------- |
| 1   | Is the `@BeforeInsert` hook executed?                  |      | Prototype chain needed |
| 2   | If the hook does not execute, is it documented?        |      |                        |
| 3   | Does the hook execute when passing a `new Cat()` instance? |      | Control group          |

### S-6. EntitySubscriber Event Order

```typescript
em.addSubscriber({
  beforeInsert(event) {
    console.log("1. beforeInsert");
  },
  afterInsert(event) {
    console.log("2. afterInsert");
  },
});
await catRepo.save({ name: "Nabi" });
```

| #   | Check Item                                              | Pass | Notes      |
| --- | ------------------------------------------------------- | ---- | ---------- |
| 1   | Is the order `beforeInsert` -> `afterInsert`?           |      |            |
| 2   | Does `event.entity` contain the saved data?             |      |            |
| 3   | If a value is modified in `beforeInsert`, is it reflected in DB? |      | Mutation   |

### S-7. FK Value is Falsy (0)

```typescript
// Referencing a parent with PK of 0 (manual PK, not AUTO_INCREMENT)
const owner = await ownerRepo.save({ id: 0, name: "Zero" });
cat.owner = owner;
await catRepo.save(cat);
```

| #   | Check Item                                  | Pass | Notes          |
| --- | ------------------------------------------- | ---- | -------------- |
| 1   | Is the FK saved as `0`? (not null)          |      | `0 !== null`   |
| 2   | Is the owner loaded correctly on query?     |      |                |

### S-8. Large-Scale Data Pagination

```typescript
// Insert 1000 records then cursor paginate
for (let i = 0; i < 1000; i++) {
  await catRepo.save({ name: `Cat_${i}` });
}

let cursor = undefined;
let total = 0;
do {
  const page = await catRepo.findWithCursor({
    take: 50,
    cursor,
    orderBy: "id",
    direction: "ASC",
  });
  total += page.data.length;
  cursor = page.nextCursor;
} while (cursor);
```

| #   | Check Item                                              | Pass | Notes              |
| --- | ------------------------------------------------------- | ---- | ------------------ |
| 1   | Is `total === 1000`?                                    |      | No missing/duplicates |
| 2   | Are there no duplicates at page boundaries?             |      |                    |
| 3   | Is `nextCursor` null/undefined on the last page?        |      | Termination condition |

### S-9. QueryBuilder — Complex Conditions

```typescript
const result = await em
  .createQueryBuilder(Cat)
  .where("age > :minAge", { minAge: 3 })
  .andWhere("name LIKE :pattern", { pattern: "%na%" })
  .orderBy("age", "DESC")
  .limit(10)
  .getMany();
```

| #   | Check Item                                                             | Pass | Notes             |
| --- | ---------------------------------------------------------------------- | ---- | ----------------- |
| 1   | Is it safe against SQL Injection attempts? `{ pattern: "'; DROP TABLE--" }` |      | Parameter binding |
| 2   | Do results match the sort condition?                                   |      |                   |
| 3   | Is the limit applied?                                                  |      |                   |

---

## Environment Setup

### Prerequisites

```bash
# 1. Build the ORM
pnpm build

# 2. Navigate to example project
cd examples/nestjs-cats   # or nestjs-blog

# 3. Install dependencies
pnpm install

# 4. Run DB with Docker (MySQL example)
docker run -d --name stingerloom-test \
  -e MYSQL_ROOT_PASSWORD=test \
  -e MYSQL_DATABASE=stingerloom \
  -p 3306:3306 mysql:8

# 5. Start server
pnpm start
```

### Verification Methods

1. **HTTP Client** — Test via REST API endpoints (curl, Postman, httpie)
2. **DB Query** — Check tables via `mysql -u root -p` or `psql`
3. **Add Integration Tests** — Automate each scenario in `__tests__/integration/` or example e2e

### DB Query Examples

```sql
-- Verify ManyToOne FK is saved correctly
SELECT c.id, c.name, c.owner_id, o.name as owner_name
FROM cat c
LEFT JOIN owner o ON c.owner_id = o.id;

-- Verify Soft Delete
SELECT id, name, deleted_at FROM cat WHERE id = 1;

-- Verify tenant isolation (PostgreSQL)
SELECT schemaname, tablename FROM pg_tables
WHERE schemaname IN ('public', 'tenant_a', 'tenant_b');
```

---

## Result Recording Template

Result recording format for each scenario:

```
## Test Date: YYYY-MM-DD
## Tester:
## DB: MySQL 8 / PostgreSQL 15
## ORM Version:

### Junior Scenarios
- [x] J-1: Query immediately after entity creation — Pass
- [ ] J-2: ManyToOne object assignment — Fail (FK saved as NULL)
- [x] J-3: Direct FK column specification — Pass
  ...

### Issues Found
| # | Scenario | Symptom | Severity | Issue Link |
|---|---------|--------|----------|-----------|
| 1 | J-2 | FK is NULL when assigning owner object | Critical | #12 |
```

---

## Automation Priority

The following scenarios have the highest priority for automation as integration tests.

| Priority              | Scenarios               | Reason                                        |
| --------------------- | ----------------------- | --------------------------------------------- |
| P0 (Immediate)        | J-2, J-3, M-1, M-2, S-7 | FK processing core path — area where bugs already occurred |
| P1 (Before Release)   | J-1, J-4~J-6, M-3~M-6   | Basic CRUD + relation round-trip             |
| P2 (On Driver Change) | M-7, S-9                | Driver-specific SQL differences              |
| P3 (Infrastructure)   | S-1~S-4, S-8            | Concurrency, connection pool, multi-tenancy   |
