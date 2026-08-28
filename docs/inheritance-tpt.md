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

## 11. DELETE -- Two-Phase Delete

Deleting a TPT child entity requires two DELETE statements in a specific order.

```typescript
await em.delete(CreditCardPayment, { id: 1 });
```

**Generated SQL (PostgreSQL):**

```sql
-- Phase 1: Delete from child table FIRST
DELETE FROM "credit_card_payment" WHERE "id" = 1;

-- Phase 2: Delete from root table SECOND
DELETE FROM "payment" WHERE "id" = 1;
```

**Return value:**

```typescript
{ affected: 1 }
```

Notice the order: child first, then root. This is required because the child table's `id` column has a foreign key constraint referencing the root table. If you deleted the root row first, the FK constraint would be violated. The ORM handles this ordering automatically.

::: warning
If you delete from the root entity directly (`em.delete(Payment, { id: 1 })`), only the root table row is deleted. The child table row will become an orphan if the FK constraint uses `NO ACTION`. To avoid orphans, always delete using the child entity class, or configure `ON DELETE CASCADE` on the child table's FK constraint.
:::

## 12. Pros and Cons

| Pros | Cons |
|------|------|
| Normalized schema -- no wasted NULL columns | Every query requires a JOIN (root + child) |
| Child columns can have NOT NULL constraints | INSERT requires two statements (root + child) |
| Scales well with many child types | DELETE requires two statements (child + root) |
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
