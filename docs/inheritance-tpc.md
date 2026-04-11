# Table Per Class Inheritance (TPC)

## 1. What is Table Per Class Inheritance?

**Table Per Class** (also called Concrete Table Inheritance) maps each entity in the hierarchy to its own independent table that contains ALL columns -- both inherited and class-specific. Think of it like each family member living in a completely separate house, each with their own copy of the shared furniture. There is no shared space at all. No foreign keys link parent and child tables, no discriminator column is stored physically, and no JOINs are needed for single-entity queries.

## 2. The Schema

Each entity gets a fully self-contained table. The parent's columns (`id`, `amount`) are duplicated in every child table.

**PostgreSQL DDL:**

```sql
CREATE TABLE "payment" (
  "id" SERIAL PRIMARY KEY,
  "amount" INTEGER NOT NULL
);

CREATE TABLE "credit_card_payment" (
  "id" SERIAL PRIMARY KEY,
  "amount" INTEGER NOT NULL,
  "cardNumber" VARCHAR(255) NOT NULL
);

CREATE TABLE "bank_transfer_payment" (
  "id" SERIAL PRIMARY KEY,
  "amount" INTEGER NOT NULL,
  "bankCode" VARCHAR(255) NOT NULL
);
```

**MySQL DDL:**

```sql
CREATE TABLE `payment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `amount` INT NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `credit_card_payment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `amount` INT NOT NULL,
  `cardNumber` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `bank_transfer_payment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `amount` INT NOT NULL,
  `bankCode` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);
```

Notice three things:

1. There are **no foreign keys** between the three tables. They are completely independent.
2. The columns `id` and `amount` are **duplicated** in every table. Each table is self-sufficient.
3. There is **no discriminator column** physically stored. When querying polymorphically, the ORM synthesizes one on-the-fly using `UNION ALL`.

## 3. Entity Definition

```typescript
// payment.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Inheritance,
  DiscriminatorColumn,
} from "@stingerloom/orm";

@Entity()
@Inheritance({ strategy: "TABLE_PER_CLASS" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;
}
```

```typescript
// credit-card-payment.entity.ts
import { Entity, Column, DiscriminatorValue } from "@stingerloom/orm";
import { Payment } from "./payment.entity";

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column()
  cardNumber!: string;
}
```

```typescript
// bank-transfer-payment.entity.ts
import { Entity, Column, DiscriminatorValue } from "@stingerloom/orm";
import { Payment } from "./payment.entity";

@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column()
  bankCode!: string;
}
```

Notice that each child class uses `@Entity()` without specifying a `name` -- the table name defaults to the snake_case of the class name (e.g., `CreditCardPayment` becomes `credit_card_payment`). Unlike STI, TPC children do **not** share the parent's table name. Each class lives in its own table.

The `@DiscriminatorColumn` decorator is still applied to the root entity, but for TPC the discriminator is not stored in the database. It is used only by the ORM to synthesize a virtual column during polymorphic `UNION ALL` queries.

## 4. INSERT -- Direct Insert

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
```

**Generated SQL (PostgreSQL):**

```sql
INSERT INTO "credit_card_payment" ("amount", "cardNumber")
VALUES (100, '4111-1111-1111-1111')
RETURNING *;
```

**Raw SQL result:**

| id | amount | cardNumber          |
|----|--------|---------------------|
| 1  | 100    | 4111-1111-1111-1111 |

**Deserialized TypeScript object:**

```typescript
CreditCardPayment {
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
```

This is the simplest INSERT of all three strategies. There is no parent table to insert into (unlike TPT), no discriminator column to set (unlike STI). One row goes into one table. That is it.

A bank transfer works the same way -- single INSERT into `bank_transfer_payment`:

```typescript
const bt = await em.save(BankTransferPayment, {
  amount: 200,
  bankCode: "SWIFT123",
});
// BankTransferPayment { id: 1, amount: 200, bankCode: "SWIFT123" }
```

## 5. SELECT -- Querying a Child Entity

When you query a child entity, the ORM queries its own table directly. No JOINs, no subqueries, no union.

```typescript
const cards = await em.find(CreditCardPayment, {});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "id", "amount", "cardNumber"
FROM "credit_card_payment";
```

**Raw SQL result:**

| id | amount | cardNumber          |
|----|--------|---------------------|
| 1  | 100    | 4111-1111-1111-1111 |

**Deserialized TypeScript object:**

```typescript
[
  CreditCardPayment {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
```

This is the fastest SELECT of all three strategies -- direct table access with no JOINs and no discriminator filtering. The database does not touch any other table.

## 6. SELECT -- Polymorphic Query (Root Entity) with UNION ALL

This is where TPC gets interesting. When you query the root entity `Payment`, the ORM must combine rows from **all** tables in the hierarchy. It does this with a `UNION ALL` query, padding missing columns with `NULL`.

```typescript
const all = await em.find(Payment, {});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT * FROM (
  SELECT "id", "amount", "cardNumber", NULL AS "bankCode",
         'Payment' AS "payment_type"
  FROM "payment"
  UNION ALL
  SELECT "id", "amount", "cardNumber", NULL AS "bankCode",
         'credit_card' AS "payment_type"
  FROM "credit_card_payment"
  UNION ALL
  SELECT "id", "amount", NULL AS "cardNumber", "bankCode",
         'bank_transfer' AS "payment_type"
  FROM "bank_transfer_payment"
) "_tpc";
```

Notice four things:

1. Each sub-SELECT lists **every** column from the entire hierarchy. If a table does not have a column, `NULL` is used as a placeholder.
2. A virtual `"payment_type"` column is synthesized using the `@DiscriminatorValue` string. This column does not exist in any table -- it is created on-the-fly.
3. The entire UNION is wrapped in a subquery aliased as `"_tpc"`.
4. The root entity (`Payment`) is included as a sub-SELECT too, with `NULL` for child-specific columns.

**Raw SQL result:**

| id | amount | cardNumber          | bankCode | payment_type  |
|----|--------|---------------------|----------|---------------|
| 1  | 50     | NULL                | NULL     | Payment       |
| 1  | 100    | 4111-1111-1111-1111 | NULL     | credit_card   |
| 1  | 200    | NULL                | SWIFT123 | bank_transfer |

**Deserialized TypeScript object:**

```typescript
[
  Payment { id: 1, amount: 50 },
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 1, amount: 200, bankCode: "SWIFT123" }
]
```

The `ResultTransformer.toPolymorphicEntities()` method reads the synthesized `payment_type` column, looks up the matching entity class from the discriminator map, and instantiates the correct subclass. Each object in the returned array is a proper `instanceof` its respective class.

::: warning
UNION ALL scans **all** tables in the hierarchy on every query. If you have 3 child tables with 1 million rows each, every polymorphic query reads 3 million rows. Use polymorphic queries sparingly with large datasets. Prefer querying child entities directly when you know the type.
:::

## 7. SELECT -- With findOne

```typescript
const card = await em.findOne(CreditCardPayment, {
  where: { id: 1 },
});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "id", "amount", "cardNumber"
FROM "credit_card_payment"
WHERE "id" = 1
LIMIT 1;
```

**Raw SQL result:**

| id | amount | cardNumber          |
|----|--------|---------------------|
| 1  | 100    | 4111-1111-1111-1111 |

**Deserialized TypeScript object:**

```typescript
CreditCardPayment {
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
```

This is identical to a non-inheritance `findOne`. Since TPC children have their own table, no extra logic is needed.

## 8. SELECT -- With QueryBuilder

```typescript
const cards = await em
  .createQueryBuilder(CreditCardPayment, "cc")
  .where("amount", 100)
  .getMany();
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "cc".*
FROM "credit_card_payment" "cc"
WHERE "cc"."amount" = 100;
```

**Raw SQL result:**

| id | amount | cardNumber          |
|----|--------|---------------------|
| 1  | 100    | 4111-1111-1111-1111 |

**Deserialized TypeScript object:**

```typescript
[
  CreditCardPayment {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
```

QueryBuilder on a TPC child just queries its own table -- it works naturally, exactly like any non-inheritance entity.

::: tip
Polymorphic queries via QueryBuilder are not supported. The `UNION ALL` logic is only available through `em.find()` and `em.findOne()` on the root entity.
:::

## 9. SELECT -- With WriteBuffer

The WriteBuffer (Unit of Work plugin) delegates to `EntityManager` internally, so inheritance strategies work transparently. The identity map correctly tracks subclass instances.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

// Enable the buffer plugin
em.extend(bufferPlugin());

const buf = em.buffer();

// Find child entities -- queries credit_card_payment table
const cards = await buf.find(CreditCardPayment, {});
// cards are now tracked in the identity map

// Polymorphic find -- UNION ALL across all tables
const all = await buf.find(Payment, {});
// all contains correct subclass instances (CreditCardPayment, BankTransferPayment, etc.)

// Modify a tracked entity
cards[0].amount = 999;

// Flush changes -- UPDATE hits credit_card_payment table only
const result = await buf.flush();
// result.updates === 1
```

**Generated SQL on `buf.flush()` (PostgreSQL):**

```sql
UPDATE "credit_card_payment"
SET "amount" = 999
WHERE "id" = 1;
```

The dirty tracking detects which properties changed and flushes an UPDATE to the correct child table.

## 10. UPDATE -- Direct Update

```typescript
const cc = await em.findOne(CreditCardPayment, {
  where: { id: 1 },
});

cc.amount = 200;
cc.cardNumber = "9999-9999-9999-9999";

await em.save(CreditCardPayment, cc);
```

**Generated SQL (PostgreSQL):**

```sql
UPDATE "credit_card_payment"
SET "amount" = 200, "cardNumber" = '9999-9999-9999-9999'
WHERE "id" = 1;
```

A single UPDATE on the child's own table. Unlike TPT (which must update both the parent and child table), TPC only touches one table because all columns live there.

## 11. DELETE -- Direct Delete

```typescript
await em.delete(CreditCardPayment, { id: 1 });
```

**Generated SQL (PostgreSQL):**

```sql
DELETE FROM "credit_card_payment"
WHERE "id" = 1;
```

A single DELETE from the child's own table. No cascade to a parent table (there is none to cascade to).

## 12. Pros and Cons

| | Pros | Cons |
|---|------|------|
| **Child queries** | Fastest SELECT -- direct table, no JOINs | -- |
| **INSERT** | Single INSERT, simplest of all strategies | -- |
| **UPDATE** | Single UPDATE, one table only | -- |
| **DELETE** | Single DELETE, one table only | -- |
| **Schema** | Each table is self-contained and easy to understand | Columns are duplicated across tables |
| **Polymorphic query** | -- | Requires UNION ALL (scans all tables, slow at scale) |
| **Schema changes** | -- | Adding a shared column requires ALTER TABLE on every child table |
| **Data integrity** | -- | No FK constraints between parent and child |
| **ID uniqueness** | -- | Auto-increment IDs can overlap across tables (see Section 14) |

## 13. When to Use TPC

Use TPC when each child type is queried independently and polymorphic queries are rare.

Good candidates: audit/log tables where each event type has very different fields, entities with high query volume where JOIN cost (TPT) or discriminator filtering (STI) is unacceptable, and hierarchies where shared fields are a small fraction of the total.

Bad candidates: systems that frequently need "give me all payments" (the UNION ALL cost adds up), and systems that enforce cross-type FK constraints (since tables are independent, you cannot create a FK that references "any payment").

## 14. ID Conflicts

::: warning
Since tables are independent, auto-increment IDs can overlap. `CreditCardPayment` with `id=1` and `BankTransferPayment` with `id=1` are **different rows** in different tables. When you mix results from a polymorphic query, two objects may share the same `id` value but represent completely different records.

If your application needs globally unique IDs across the hierarchy, use `@PrimaryGeneratedColumn("uuid")` instead of auto-increment:

```typescript
@PrimaryGeneratedColumn("uuid")
id!: string;
```

This generates UUIDv7 values that are unique across all tables, eliminating the overlap problem.
:::

## 15. Next Steps

- [Inheritance Mapping Overview](./inheritance-mapping.md) -- Compare all three strategies (STI, TPT, TPC) side by side
- [EntityManager](./entity-manager.md) -- find, save, delete, aggregation, pagination
- [Query Builder](./query-builder.md) -- Complex queries with JOIN, GROUP BY, subqueries
- [Write Buffer](./write-buffer.md) -- Unit of Work pattern with identity map and dirty tracking
- [Relations](./relations.md) -- @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
