# Joined / Table Per Type Inheritance (TPT) -- Deep Dive

Joined Inheritance (also called Table Per Type, or TPT) stores shared columns in a root table and child-specific columns in separate child tables, linked by a foreign key on the primary key -- like a family that shares a living room (root table) but where each person has their own bedroom (child table); to see everything about someone, you need to visit both rooms (JOIN).

This guide covers every operation in detail with exact generated SQL, raw result rows, and deserialized TypeScript objects.

## 1. The Schema

The hierarchy uses three tables: one root table (`payment`) and one table per child type.

### PostgreSQL

```sql
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50) NOT NULL
);

CREATE TABLE "credit_card_payment" (
  "id"         INT PRIMARY KEY,
  "cardNumber" VARCHAR(255) NOT NULL
);

ALTER TABLE "credit_card_payment"
  ADD CONSTRAINT "fk_credit_card_payment_id_a1b2c3d4"
  FOREIGN KEY ("id") REFERENCES "payment" ("id");

CREATE TABLE "bank_transfer_payment" (
  "id"       INT PRIMARY KEY,
  "bankCode" VARCHAR(255) NOT NULL
);

ALTER TABLE "bank_transfer_payment"
  ADD CONSTRAINT "fk_bank_transfer_payment_id_e5f6g7h8"
  FOREIGN KEY ("id") REFERENCES "payment" ("id");
```

### MySQL

```sql
CREATE TABLE `payment` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `amount`       INT NOT NULL,
  `payment_type` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `credit_card_payment` (
  `id`         INT NOT NULL,
  `cardNumber` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`id`) REFERENCES `payment` (`id`)
);

CREATE TABLE `bank_transfer_payment` (
  `id`       INT NOT NULL,
  `bankCode` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`id`) REFERENCES `payment` (`id`)
);
```

Notice three things:

1. The root table (`payment`) holds only the shared columns (`id`, `amount`) plus the discriminator column (`payment_type`)
2. Each child table's primary key is also a foreign key referencing the root table's `id` -- this guarantees every child row has a corresponding root row
3. Child columns can be NOT NULL -- unlike Single Table Inheritance, there are no "other type" rows to worry about, so the database can enforce constraints on child-specific fields

## 2. Entity Definition

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "@stingerloom/orm";

// Root entity: shared columns + strategy declaration
@Entity()
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;
}

// Child 1: own table "credit_card_payment"
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column()
  cardNumber!: string;
}

// Child 2: own table "bank_transfer_payment"
@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column()
  bankCode!: string;
}
```

Notice that children use `extends Payment` to inherit the `id` and `amount` columns, but each child gets its own table. The `@Entity()` decorator (without an explicit `name`) derives the table name from the class name: `CreditCardPayment` becomes `credit_card_payment`. If you want a custom table name, pass it explicitly: `@Entity({ name: "cc_payments" })`.

> **Hint** The `@DiscriminatorColumn` decorator is optional. If omitted, a column named `"dtype"` with type `VARCHAR(31)` is created by default.

Register all entities (root + children) in your configuration:

```typescript
await em.register({
  type: "postgres",
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

The ORM creates the root table first, then child tables, then adds the foreign key constraints from each child's `id` to the root's `id`.

## 3. INSERT -- Two-Phase Insert

When you save a child entity, the ORM splits the data across two tables in two INSERT statements.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
```

**Generated SQL (PostgreSQL):**

```sql
-- Phase 1: Insert into root table (shared columns + discriminator)
INSERT INTO "payment" ("amount", "payment_type")
VALUES (100, 'credit_card')
RETURNING *;

-- Phase 2: Insert into child table (own columns + same PK)
INSERT INTO "credit_card_payment" ("id", "cardNumber")
VALUES (1, '4111-1111-1111-1111');
```

**Phase 1 raw result:**

| id | amount | payment_type |
|----|--------|-------------|
| 1  | 100    | credit_card |

**Phase 2:** no result rows (child table INSERT does not use `RETURNING`).

**Deserialized TypeScript object:**

```typescript
{
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
// instanceof CreditCardPayment === true
```

Notice the two-phase process: the root row is inserted first to generate the `id` via `SERIAL` / `AUTO_INCREMENT`, then the child row is inserted with the same `id` as its primary key. The ORM handles the PK transfer automatically -- you never need to set `id` yourself.

Let's also insert a bank transfer:

```typescript
const bt = await em.save(BankTransferPayment, {
  amount: 250,
  bankCode: "SWIFT-ABCD",
});
```

**Generated SQL (PostgreSQL):**

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (250, 'bank_transfer')
RETURNING *;

INSERT INTO "bank_transfer_payment" ("id", "bankCode")
VALUES (2, 'SWIFT-ABCD');
```

**Deserialized TypeScript object:**

```typescript
{
  id: 2,
  amount: 250,
  bankCode: "SWIFT-ABCD"
}
// instanceof BankTransferPayment === true
```

## 4. SELECT -- Querying a Child Entity

When you query a child entity with `em.find()`, the ORM automatically JOINs the child table with the root table to assemble the complete entity.

```typescript
const cards = await em.find(CreditCardPayment, {});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id";
```

Notice the ORM uses an INNER JOIN, not a LEFT JOIN. Every child row must have a corresponding root row (enforced by the FK constraint), so INNER JOIN is correct and slightly faster.

**Raw SQL result rows:**

| id | cardNumber         | amount |
|----|--------------------|--------|
| 1  | 4111-1111-1111-1111 | 100    |

**Deserialized TypeScript objects:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
// cards[0] instanceof CreditCardPayment === true
```

Notice that the result merges columns from both tables into a single flat object. The `amount` column comes from the root table, and `cardNumber` comes from the child table. The ORM combines them transparently.

The other reads of a child go through the same JOIN, so their criteria, fields and sort columns may name inherited columns too. `count()`, `exists()`, `sum()`, `avg()`, `min()`, `max()` (and so the totals of `findAndCount()` / `findWithPage()`) and `findWithCursor()` read the joined rows as one derived table:

```typescript
await em.count(CreditCardPayment, { amount: { gte: 100 } });
```

```sql
SELECT COUNT(*) AS "result"
FROM (SELECT "credit_card_payment"."id", "credit_card_payment"."cardNumber",
             "payment"."amount", "payment"."payment_type"
      FROM "credit_card_payment" AS "credit_card_payment"
      INNER JOIN "payment" AS "payment" ON "credit_card_payment"."id" = "payment"."id") AS "_tpt"
WHERE "amount" >= 100;
```

A `@DeletedAt` column declared on the root is filtered on the root table in every one of these reads, the same way `withDeleted` / `onlyDeleted` apply to any other entity.

## 5. SELECT -- Polymorphic Query (Root Entity)

Querying the root entity returns all payment types, with each row deserialized into the correct subclass.

```typescript
const all = await em.find(Payment, {});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "payment"."id",
       "payment"."amount",
       "payment"."payment_type",
       "credit_card_payment"."cardNumber" AS "credit_card_payment_cardNumber",
       "bank_transfer_payment"."bankCode" AS "bank_transfer_payment_bankCode"
FROM "payment"
LEFT JOIN "credit_card_payment"
  ON "payment"."id" = "credit_card_payment"."id"
LEFT JOIN "bank_transfer_payment"
  ON "payment"."id" = "bank_transfer_payment"."id";
```

Notice the ORM uses LEFT JOINs for polymorphic queries. A credit card payment row will have `bank_transfer_payment_bankCode = NULL`, and vice versa. The child columns are prefixed with their table name (e.g., `credit_card_payment_cardNumber`) to avoid name collisions when multiple child tables have identically named columns.

**Raw SQL result rows:**

| id | amount | payment_type  | credit_card_payment_cardNumber | bank_transfer_payment_bankCode |
|----|--------|---------------|-------------------------------|-------------------------------|
| 1  | 100    | credit_card   | 4111-1111-1111-1111           | NULL                          |
| 2  | 250    | bank_transfer | NULL                          | SWIFT-ABCD                    |

**Deserialized TypeScript objects:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  },
  // ^ instanceof CreditCardPayment === true

  {
    id: 2,
    amount: 250,
    bankCode: "SWIFT-ABCD"
  }
  // ^ instanceof BankTransferPayment === true
]
```

The `ResultTransformer.toTPTPolymorphicEntities()` method handles this deserialization. For each row, it:

1. Reads the `payment_type` discriminator value
2. Looks up the correct TypeScript class from the discriminator map
3. Strips the table-name prefix from child columns that match (e.g., `credit_card_payment_cardNumber` becomes `cardNumber`)
4. Discards prefixed columns that belong to other child types (e.g., drops `bank_transfer_payment_bankCode` when the row is a `credit_card` type)
5. Instantiates the correct class with the flattened row data

## 6. SELECT -- With Relations

Relations defined on the root entity are inherited by all children. Here is an example with a `@ManyToOne` relation on the root `Payment` entity.

```typescript
@Entity()
export class Store {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => Payment, { mappedBy: "store" })
  payments!: Payment[];
}

@Entity()
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;

  @Column({ type: "int", nullable: true })
  storeFk!: number;

  @ManyToOne(() => Store, (s) => s.payments)
  @RelationColumn({ name: "storeFk" })
  store!: Store;
}
```

Now load a child entity with the `store` relation:

```typescript
const cards = await em.find(CreditCardPayment, {
  relations: ["store"],
});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount",
       "payment"."storeFk",
       "store"."id"   AS "store_id",
       "store"."name" AS "store_name"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id"
LEFT JOIN "store"
  ON "payment"."storeFk" = "store"."id";
```

Notice that the FK column (`storeFk`) lives in the root table (`payment`), not the child table. The ORM automatically qualifies it to the correct table: `"payment"."storeFk"` instead of `"credit_card_payment"."storeFk"`. This happens transparently -- you do not need to specify which table a column belongs to.

**Raw SQL result rows:**

| id | cardNumber          | amount | storeFk | store_id | store_name      |
|----|---------------------|--------|---------|----------|-----------------|
| 1  | 4111-1111-1111-1111 | 100    | 1       | 1        | Electronics Hub |

**Deserialized TypeScript object:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111",
    storeFk: 1,
    store: {
      id: 1,
      name: "Electronics Hub"
    }
  }
]
```

::: tip
For TPT, FK columns defined on the root entity are stored in the root table. The ORM automatically qualifies the FK column to the correct table when building JOIN queries, so you do not need to think about which table owns which column.
:::

## 7. SELECT -- With findOne

`findOne` works identically to `find` but returns a single entity or `null`.

```typescript
const cc = await em.findOne(CreditCardPayment, {
  where: { id: 1 },
});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id"
WHERE "credit_card_payment"."id" = 1
LIMIT 1;
```

Notice the WHERE clause qualifies `id` to the child table (`credit_card_payment`), and the query includes `LIMIT 1` because `findOne` expects at most one result.

**Raw SQL result row:**

| id | cardNumber          | amount |
|----|---------------------|--------|
| 1  | 4111-1111-1111-1111 | 100    |

**Deserialized TypeScript object:**

```typescript
{
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
// cc instanceof CreditCardPayment === true
// cc is CreditCardPayment | null
```

Where conditions can reference both root and child columns. The ORM automatically routes each column to the correct table:

```typescript
const expensive = await em.find(CreditCardPayment, {
  where: { amount: 100 },   // "amount" is a root column -> qualified to "payment"."amount"
});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id"
WHERE "payment"."amount" = 100;
```

## 8. SELECT -- With QueryBuilder

The `SelectQueryBuilder` **automatically applies** TPT inheritance logic. When you use `em.createQueryBuilder()` with a child entity, the parent table is auto-joined and an explicit SELECT list combining parent + child columns is built. When you query the root entity, all child tables are LEFT JOINed and polymorphic deserialization returns correct subclass instances.

**Child entity query:**

```typescript
const cards = await em
  .createQueryBuilder(CreditCardPayment, "cc")
  .where("amount", 100)
  .getMany();
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "cc"."id", "cc"."cardNumber", "payment"."amount"
FROM "credit_card_payment" AS "cc"
INNER JOIN "payment"
  ON "cc"."id" = "payment"."id"
WHERE "payment"."amount" = $1;
```

The parent table JOIN and column routing happen automatically -- root columns like `amount` are qualified to the parent table (`"payment"."amount"`), and child columns to the child table.

**Deserialized result:**

```typescript
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
```

**Polymorphic root entity query:**

```typescript
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "p"."id", "p"."amount", "p"."payment_type",
       "credit_card_payment"."cardNumber" AS "credit_card_payment_cardNumber",
       "bank_transfer_payment"."bankCode" AS "bank_transfer_payment_bankCode"
FROM "payment" AS "p"
LEFT JOIN "credit_card_payment"
  ON "p"."id" = "credit_card_payment"."id"
LEFT JOIN "bank_transfer_payment"
  ON "p"."id" = "bank_transfer_payment"."id";
```

**Deserialized result:**

```typescript
[
  CreditCardPayment  { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 2, amount: 250, bankCode: "SWIFT-ABCD" }
]
// Each element is the correct subclass instance.
// Child column prefixes (e.g., credit_card_payment_cardNumber) are stripped automatically.
```

The `ResultTransformer.toTPTPolymorphicEntities()` method handles the prefix stripping and subclass instantiation, just like `em.find()`. All QueryBuilder methods (`getMany()`, `getOne()`, `getCount()`, `exists()`) support TPT polymorphic deserialization.

## 9. SELECT -- With WriteBuffer

The WriteBuffer plugin (Unit of Work) transparently supports TPT inheritance. All queries delegate to the EntityManager, so TPT JOINs and two-phase writes happen automatically.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin());
const buf = em.buffer();

// find works transparently -- generates the same INNER JOIN
const cards = await buf.find(CreditCardPayment, {});

// findOne with polymorphic root query
const all = await buf.find(Payment, {});
all.forEach((p) => {
  if (p instanceof CreditCardPayment) {
    console.log(p.cardNumber);
  }
});

// Dirty tracking works on both root and child fields
const cc = await buf.findOne(CreditCardPayment, { where: { id: 1 } });
if (cc) {
  cc.amount = 500;       // root field
  cc.cardNumber = "9999"; // child field
}
const result = await buf.flush();
console.log(result.updates); // 1
```

**Deserialized result from `buf.find(CreditCardPayment, {})`:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
```

## 10. UPDATE -- Split Between Tables

When you update a TPT child entity, the ORM splits the changes into two UPDATE statements: one for root-table columns and one for child-table columns.

```typescript
const cc = await em.findOne(CreditCardPayment, { where: { id: 1 } });

cc.amount = 200;                      // root column
cc.cardNumber = "5555-5555-5555-5555"; // child column

await em.save(CreditCardPayment, cc);
```

**Generated SQL (PostgreSQL):**

```sql
-- Phase 1: Update root table (shared columns)
UPDATE "payment"
SET "amount" = 200
WHERE "id" = 1;

-- Phase 2: Update child table (own columns)
UPDATE "credit_card_payment"
SET "cardNumber" = '5555-5555-5555-5555'
WHERE "id" = 1;
```

**Deserialized TypeScript object after save:**

```typescript
{
  id: 1,
  amount: 200,
  cardNumber: "5555-5555-5555-5555"
}
```

Notice the ORM intelligently routes each column to the correct table. If you only change a root column (e.g., `amount`), only the root table UPDATE is executed. If you only change a child column, only the child table UPDATE is executed. The ORM skips empty UPDATE statements.

> **Hint** `@UpdateTimestamp` and `@Version` fields are routed to the root table's UPDATE statement, since these metadata columns are typically defined on the root entity.

### Criteria updates

`updateMany()`, `update()`, `increment()` / `decrement()`, `softDelete()` and `restore()` on a child take the route `delete()` does (section 11): the ORM reads the primary keys the criteria match through the root JOIN, then each table takes the assignments to its own columns by those keys.

```typescript
await em.updateMany(
  CreditCardPayment,
  { amount: 0, cardNumber: "void" },
  { where: { amount: { lt: 10 } }, orderBy: { amount: "ASC" }, limit: 100 },
);
```

**Generated SQL (PostgreSQL):**

```sql
-- Phase 1: the matching keys, in order and limited, locked for the update
SELECT "tpt_root"."id" AS "pk"
FROM "credit_card_payment" AS "tpt_child"
INNER JOIN "payment" AS "tpt_root" ON "tpt_child"."id" = "tpt_root"."id"
WHERE "tpt_root"."amount" < 10
ORDER BY "tpt_root"."amount" ASC LIMIT 100 FOR UPDATE;

-- Phase 2: root columns, including @UpdateTimestamp and the @Version bump
UPDATE "payment" SET "amount" = 0 WHERE "id" IN (4, 9);

-- Phase 3: child columns
UPDATE "credit_card_payment" SET "cardNumber" = 'void' WHERE "id" IN (4, 9);
```

- A column goes to the table that holds it. Columns the root declares -- including its `@UpdateTimestamp`, `@Version`, `@DeletedAt` and the join columns of its relations -- go to the root table; the child's own columns go to the child table. A table with no assignment gets no statement.
- `affected` is the number of root rows updated when the root statement runs, and the number of child rows otherwise.
- A criteria on an inherited column only reaches rows of the class you called, and a primary key of another subclass matches nothing.
- `orderBy` and `limit` apply to the key read, so they may name columns of either table.
- On PostgreSQL and MySQL the key read takes `FOR UPDATE`, so the statements that follow write exactly the rows it matched. SQLite serializes writes itself and gets no lock clause.
- Under `tenantStrategy: "tenant_column"` the tenant predicate goes into the key read, on the root table.

`createUpdateBuilder()` is not covered: its `where()` conditions arrive as rendered SQL, so it still runs a single UPDATE against the child table, which can only name the child's own columns.

## 11. DELETE -- Keys First, Child Tables Before Root

A TPT row lives in two tables, and the criteria may name columns of either one. The ORM first reads the primary keys that match, then deletes those keys from the child table and then from the root table.

```typescript
await em.delete(CreditCardPayment, { cardNumber: "4111-1111-1111-1111" });
```

**Generated SQL (PostgreSQL):**

```sql
-- Phase 1: find the matching keys. The root is joined, and each column
-- is qualified with the table that holds it
SELECT "tpt_root"."id" AS "pk"
FROM "credit_card_payment" AS "tpt_child"
INNER JOIN "payment" AS "tpt_root" ON "tpt_child"."id" = "tpt_root"."id"
WHERE "tpt_child"."cardNumber" = '4111-1111-1111-1111'
FOR UPDATE;

-- Phase 2: delete from the child table FIRST
DELETE FROM "credit_card_payment" WHERE "id" IN (1);

-- Phase 3: delete from the root table SECOND
DELETE FROM "payment" WHERE "id" IN (1);
```

**Return value:**

```typescript
{ affected: 1 }
```

The child table goes first because its `id` column has a foreign key referencing the root table: deleting the root row first would violate that constraint. `affected` is the number of root rows deleted.

Because the keys come from the JOIN, a criteria on an inherited column only reaches rows of the class you called `delete()` on. `em.delete(CreditCardPayment, { amount: 0 })` leaves a `BankTransferPayment` with `amount: 0` alone, and `em.delete(CreditCardPayment, { id })` deletes nothing when `id` belongs to another subclass.

**Deleting through the root entity** removes each matching row from every table it occupies:

```typescript
await em.delete(Payment, { amount: 0 });
```

```sql
SELECT "tpt_root"."id" AS "pk" FROM "payment" AS "tpt_root" WHERE "tpt_root"."amount" = 0 FOR UPDATE;
DELETE FROM "credit_card_payment" WHERE "id" IN (3, 7);
DELETE FROM "bank_transfer_payment" WHERE "id" IN (3, 7);
DELETE FROM "payment" WHERE "id" IN (3, 7);
```

Every child table is cleared before the root, so no child row is left without its root row, whether or not the database enforces the foreign key (MyISAM, for example, does not). `deleteMany()` follows the same rules on a child or on the root.

| Call | Keys read from | Tables deleted |
|------|----------------|----------------|
| `delete(Child, criteria)` / `deleteMany(Child, ids)` | child `INNER JOIN` root | child, then root |
| `delete(Root, criteria)` / `deleteMany(Root, ids)` | root | every child table, then root |

Under `tenantStrategy: "tenant_column"`, the tenant predicate goes into the key lookup against the root table, which holds the tenant column. On PostgreSQL and MySQL the key lookup takes `FOR UPDATE` (SQLite has no lock clause). Keys are deleted in batches of 1,000 per `IN (...)` list, and every statement runs in one transaction.

## 12. Pros and Cons

| Pros | Cons |
|------|------|
| Normalized schema -- no wasted NULL columns | Every query requires a JOIN (root + child) |
| Child columns can have NOT NULL constraints | INSERT requires two statements (root + child) |
| Scales well with many child types | DELETE requires a key lookup plus a statement per table |
| Clean separation of concerns per type | Polymorphic queries need N LEFT JOINs |
| Adding a child type does not alter existing tables | Slightly more complex schema than STI |
| Root table stays narrow regardless of child count | WHERE clauses must be routed to the correct table |

## 13. When to Use TPT

Use Joined / Table Per Type inheritance when:

- **Child-specific columns are many.** If each child type adds 4+ columns, STI would create a table with dozens of mostly-NULL columns. TPT keeps each child table lean.
- **NOT NULL constraints on child columns are important.** STI forces all child-specific columns to be nullable. TPT lets you enforce `NOT NULL` on `cardNumber` for credit card payments.
- **Schema normalization matters.** TPT produces a fully normalized schema where every column in every table is relevant to every row in that table.
- **You frequently query specific child types.** The INNER JOIN for child queries is fast and predictable.
- **You occasionally need polymorphic queries.** The LEFT JOIN approach is slower than STI's single-table scan but faster than TPC's UNION ALL.

Avoid TPT when:

- **Polymorphic queries are the primary access pattern.** If most queries fetch all payment types, the N LEFT JOINs add overhead. Consider STI instead.
- **The hierarchy has very few child-specific columns.** If each child adds only 1-2 columns, STI is simpler and faster.
- **You need maximum INSERT/DELETE performance.** The two-phase write adds latency. Consider TPC for write-heavy workloads where polymorphic reads are rare.

## 14. Next Steps

- [Inheritance Mapping](./inheritance-mapping.md) -- Overview of all three strategies (STI, TPT, TPC)
- [Relations](./relations.md) -- @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- [EntityManager](./entity-manager.md) -- find, save, delete, aggregation, pagination
- [Write Buffer](./write-buffer.md) -- Unit of Work pattern with dirty tracking
- [Query Builder](./query-builder.md) -- Complex SQL with JOIN, GROUP BY, subqueries
