# Single Table Inheritance (STI) -- Deep Dive

Single Table Inheritance maps an entire class hierarchy -- parent and all children -- into **one database table**, using a discriminator column to tell each row apart.

Think of it like a family sharing one room. Everyone sleeps in the same room, but each person wears a name tag so you know who is who. The room is the table, the name tag is the discriminator column.

This guide walks through every CRUD operation and shows three things for each: the TypeScript API call, the exact SQL the ORM generates, and the raw result rows alongside the deserialized TypeScript objects. If you want a high-level comparison of all three inheritance strategies (STI, TPT, TPC), start with the [Inheritance Mapping overview](./inheritance-mapping.md) first.

## The Schema

When you use STI, Stingerloom merges every column from every child into a single CREATE TABLE statement. A discriminator column is added to identify which class each row belongs to.

**PostgreSQL:**

```sql
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50),
  "cardNumber"   VARCHAR(255),
  "bankCode"     VARCHAR(255)
);
```

**MySQL:**

```sql
CREATE TABLE `payment` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `amount`       INT NOT NULL,
  `payment_type` VARCHAR(50),
  `cardNumber`   VARCHAR(255),
  `bankCode`     VARCHAR(255),
  PRIMARY KEY (`id`)
);
```

Notice three things:

1. All columns from all children (`cardNumber` from CreditCardPayment, `bankCode` from BankTransferPayment) live in **one** table
2. The `payment_type` column is the discriminator -- it stores `'credit_card'`, `'bank_transfer'`, or the root class name
3. Child-specific columns are **nullable** because a credit card row will have `bankCode = NULL`, and vice versa

## Entity Definition

Three decorators work together: `@Inheritance` on the root sets the strategy, `@DiscriminatorColumn` configures the discriminator column, and `@DiscriminatorValue` on each child assigns a label.

```typescript
import {
  Entity, PrimaryGeneratedColumn, Column,
  Inheritance, DiscriminatorColumn, DiscriminatorValue,
  ManyToOne, OneToMany,
} from "@stingerloom/orm";

// ── Root entity ──
@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;
}

// ── Child: CreditCardPayment ──
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true })
  cardNumber!: string;
}

// ── Child: BankTransferPayment ──
@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column({ nullable: true })
  bankCode!: string;
}
```

Register all entities (root and every child) in your configuration:

```typescript
await em.register({
  type: "postgres",
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

::: warning
Child-specific columns **must** be `nullable: true`. A CreditCardPayment row has `bankCode = NULL`, and a BankTransferPayment row has `cardNumber = NULL`. If you mark them NOT NULL, inserts for other types will fail with a constraint violation.
:::

If you omit `@DiscriminatorColumn`, Stingerloom creates a column named `"dtype"` with type `VARCHAR(31)` by default. If you omit `@DiscriminatorValue` on a child, the class name is used as the value (e.g., `"CreditCardPayment"`).

## INSERT -- How Discriminator Values Are Set

You never set the discriminator value yourself. The ORM reads it from `@DiscriminatorValue("credit_card")` and injects it into every INSERT automatically.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
```

**Generated SQL (PostgreSQL):**

```sql
INSERT INTO "payment" ("amount", "cardNumber", "payment_type")
VALUES (100, '4111-1111-1111-1111', 'credit_card')
RETURNING *;
```

**Generated SQL (MySQL):**

```sql
INSERT INTO `payment` (`amount`, `cardNumber`, `payment_type`)
VALUES (100, '4111-1111-1111-1111', 'credit_card');
```

The returned entity:

```typescript
// cc is:
CreditCardPayment {
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
```

Notice: the `payment_type` column value `'credit_card'` was set by the ORM. The discriminator does not appear as a property on the TypeScript object -- it is metadata, not business data.

Let's also insert a bank transfer and a root payment so we have data for the SELECT examples:

```typescript
const bt = await em.save(BankTransferPayment, {
  amount: 200,
  bankCode: "SWIFT123",
});
// bt is:
// BankTransferPayment { id: 2, amount: 200, bankCode: "SWIFT123" }

const plain = await em.save(Payment, { amount: 50 });
// plain is:
// Payment { id: 3, amount: 50 }
```

The root entity also gets a discriminator value. Since `Payment` has no `@DiscriminatorValue`, the class name `"Payment"` is used:

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (50, 'Payment')
RETURNING *;
```

### Every INSERT path writes it

The same value goes into every row, whichever method writes it: `save()`, `saveMany()`, `insertMany()`, `insertManyAndReturn()`, `upsert()`, `insertIgnore()`, `batchUpsert()`, `createInsertBuilder()` and a WriteBuffer flush. A value the payload states for the discriminator column is overwritten.

```typescript
await em.insertMany(CreditCardPayment, [{ amount: 10 }, { amount: 20 }]);
```

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (10, 'credit_card'), (20, 'credit_card');
```

### Upserting through a child

All subtypes share one table, so they share one key space too. The conflict branch of `upsert()`, `batchUpsert()` and `createInsertBuilder().doUpdate()` only rewrites a row of the same subtype. When the conflicting key belongs to another subtype's row, that row is left as it is and counted as not affected; PostgreSQL and SQLite also log a warning, once per entity class.

```typescript
// id 2 is the BankTransferPayment inserted above
await em.upsert(CreditCardPayment, { id: 2, amount: 999 });
// { affected: 0 } -- the bank transfer is untouched
```

**Generated SQL (PostgreSQL):**

```sql
INSERT INTO "payment" ("id", "amount", "payment_type")
VALUES (2, 999, 'credit_card')
ON CONFLICT ("id") DO UPDATE SET "amount" = EXCLUDED."amount"
WHERE "payment"."payment_type" = 'credit_card';
```

**Generated SQL (MySQL):** `ON DUPLICATE KEY UPDATE` takes no WHERE, so each assignment carries the check:

```sql
INSERT INTO `payment` (`id`, `amount`, `payment_type`)
VALUES (2, 999, 'credit_card')
ON DUPLICATE KEY UPDATE
  `amount` = IF(`payment`.`payment_type` = 'credit_card', VALUES(`amount`), `payment`.`amount`);
```

Upserting through the root (`em.upsert(Payment, ...)`) updates whichever subtype's row holds the key and leaves its discriminator alone.

## SELECT -- Querying a Child Entity (em.find)

When you query a child entity, the ORM automatically adds a `WHERE` clause filtering by the discriminator value. You never see rows from other types.

```typescript
const cards = await em.find(CreditCardPayment, {});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT * FROM "payment"
WHERE "payment_type" = 'credit_card';
```

**Generated SQL (MySQL):**

```sql
SELECT * FROM `payment`
WHERE `payment_type` = 'credit_card';
```

**Raw SQL result:**

```
| id | amount | payment_type | cardNumber          | bankCode |
|----|--------|------------- |---------------------|----------|
|  1 |    100 | credit_card  | 4111-1111-1111-1111 | NULL     |
```

**Deserialized result:**

```typescript
// cards is:
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
```

Notice: `bankCode` (which belongs to BankTransferPayment) is **not** on the result object. The ORM maps only the columns that belong to the `CreditCardPayment` class. The NULL columns from other siblings are silently dropped during deserialization.

## SELECT -- Polymorphic Query (Root Entity)

Querying the root entity returns **all** rows from the table, with no discriminator filter. The ORM reads the discriminator value of each row and instantiates the correct TypeScript class.

```typescript
const all = await em.find(Payment, {});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT * FROM "payment";
```

**Raw SQL result:**

```
| id | amount | payment_type  | cardNumber          | bankCode |
|----|--------|---------------|---------------------|----------|
|  1 |    100 | credit_card   | 4111-1111-1111-1111 | NULL     |
|  2 |    200 | bank_transfer | NULL                | SWIFT123 |
|  3 |     50 | Payment       | NULL                | NULL     |
```

**Deserialized result:**

```typescript
// all is:
[
  CreditCardPayment  { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 2, amount: 200, bankCode: "SWIFT123" },
  Payment             { id: 3, amount: 50 }
]

// Runtime type checks work:
all[0] instanceof CreditCardPayment  // true
all[1] instanceof BankTransferPayment // true
all[2] instanceof Payment             // true
```

Notice: each element in the array is the **correct subclass instance**. The `CreditCardPayment` object has `cardNumber` but not `bankCode`. The `BankTransferPayment` object has `bankCode` but not `cardNumber`. The root `Payment` object has neither.

### How Polymorphic Deserialization Works

Internally, the ORM follows this process for each row:

1. Read the `payment_type` column value from the raw row
2. Look up the discriminator map: `{ "credit_card" => CreditCardPayment, "bank_transfer" => BankTransferPayment, "Payment" => Payment }`
3. Find the matching class constructor
4. Instantiate the class and map only the relevant columns
5. Apply column transformers (if any)

This logic lives in `ResultTransformer.toPolymorphicEntities()`. The discriminator map is built once by `InheritanceResolver.buildDiscriminatorMap()` and cached for the query.

## SELECT -- With Relations

Inheritance entities support standard `@ManyToOne` and `@OneToMany` relations. Define the relation on the root entity so that all children inherit it.

```typescript
@Entity()
export class Store {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @OneToMany(() => Payment, { mappedBy: "store" })
  payments!: Payment[];
}

@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;

  @Column({ type: "int", nullable: true })
  storeId!: number;

  // FK column auto-detected from the storeId @Column above
  @ManyToOne(() => Store, (s) => s.payments)
  store!: Store;
}

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;
}
```

Now fetch credit card payments with their store:

```typescript
const cards = await em.find(CreditCardPayment, {
  relations: ["store"],
});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT
  "payment"."id",
  "payment"."amount",
  "payment"."storeId",
  "payment"."payment_type",
  "payment"."cardNumber",
  "payment"."bankCode",
  "store"."id"   AS "store__id",
  "store"."name" AS "store__name"
FROM "payment"
LEFT JOIN "store" AS "store" ON "payment"."storeId" = "store"."id"
WHERE "payment"."payment_type" = 'credit_card';
```

**Raw SQL result:**

```
| payment_id | payment_amount | payment_payment_type | payment_cardNumber  | payment_bankCode | store_id | store_name     |
|------------|----------------|----------------------|---------------------|------------------|----------|----------------|
|          1 |            100 | credit_card          | 4111-1111-1111-1111 | NULL             |        1 | ElectronicsMart |
```

**Deserialized result:**

```typescript
// cards is:
[
  CreditCardPayment {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111",
    store: Store { id: 1, name: "ElectronicsMart" }
  }
]
```

Notice: the discriminator WHERE clause (`payment_type = 'credit_card'`) is combined with the LEFT JOIN. The `store` property is a fully deserialized `Store` instance nested inside the `CreditCardPayment`.

A polymorphic read of the root loads relations the same way and still returns each row as its subclass: `em.find(Payment, { relations: ["store"] })` gives `CreditCardPayment` and `BankTransferPayment` instances, each with its `store`.

### A relation a subclass declares

A child can declare relations of its own next to the ones it inherits. Their join columns live on the shared table like the child's other columns, and like them they are nullable -- a row of another subtype leaves them empty -- whatever `@RelationColumn({ nullable })` says.

```typescript
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;

  @ManyToOne(() => Bank, (b) => b.cards)
  @RelationColumn({ name: "issuer_id" })
  issuer!: Bank; // payment.issuer_id, NULL on other payment types
}

const cards = await em.find(CreditCardPayment, { relations: ["store", "issuer"] });
```

## SELECT -- With findOne

`findOne` works exactly like `find` but returns a single entity or `null`.

```typescript
const cc = await em.findOne(CreditCardPayment, {
  where: { amount: 100 },
});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT * FROM "payment"
WHERE "payment_type" = 'credit_card' AND "amount" = 100
LIMIT 1;
```

**Raw SQL result:**

```
| id | amount | payment_type | cardNumber          | bankCode |
|----|--------|------------- |---------------------|----------|
|  1 |    100 | credit_card  | 4111-1111-1111-1111 | NULL     |
```

**Deserialized result:**

```typescript
// cc is:
CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
// (or null if no match)
```

Notice: both conditions are ANDed together. The discriminator filter is always first, then your custom WHERE clause.

## SELECT -- With QueryBuilder

The `SelectQueryBuilder` **automatically applies** STI inheritance logic. When you use `em.createQueryBuilder()` with a child entity, the discriminator WHERE clause is injected automatically. When you query the root entity, polymorphic deserialization returns correct subclass instances.

**Child entity query:**

```typescript
const cards = await em
  .createQueryBuilder(CreditCardPayment, "p")
  .where("amount", 100)
  .getMany();
```

**Generated SQL (PostgreSQL):**

```sql
SELECT "p".* FROM "payment" AS "p"
WHERE "p"."payment_type" = 'credit_card' AND "p"."amount" = $1;
```

The discriminator filter `payment_type = 'credit_card'` is added automatically -- you do not need to specify it.

**Raw SQL result:**

```
| id | amount | payment_type | cardNumber          | bankCode |
|----|--------|--------------|---------------------|----------|
|  1 |    100 | credit_card  | 4111-1111-1111-1111 | NULL     |
```

**Deserialized result:**

```typescript
// cards is:
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
SELECT "p".* FROM "payment" AS "p";
```

**Deserialized result:**

```typescript
// all is:
[
  CreditCardPayment  { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 2, amount: 200, bankCode: "SWIFT123" },
  Payment             { id: 3, amount: 50 }
]
// Each element is the correct subclass instance -- instanceof checks work.
```

The QueryBuilder reads the discriminator value of each row and instantiates the correct TypeScript class, just like `em.find()`. All QueryBuilder methods (`getMany()`, `getOne()`, `getCount()`, `exists()`) support this polymorphic deserialization.

## SELECT -- With WriteBuffer

The WriteBuffer plugin (Unit of Work) transparently delegates to `EntityManager.find()`. All inheritance logic -- discriminator WHERE, polymorphic deserialization -- works exactly the same.

```typescript
const buf = em.buffer();

const cards = await buf.find(CreditCardPayment, {});
// Transparent -- delegates to em.find(), identity map tracks results
```

**Generated SQL:** Same as `em.find(CreditCardPayment, {})` -- see above.

**Deserialized result:**

```typescript
// cards is:
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
// The WriteBuffer's identity map now tracks this entity.
// Future findOne() calls with the same PK hit the identity map, skipping the DB.
```

Polymorphic queries also work:

```typescript
const all = await buf.find(Payment, {});
// all contains CreditCardPayment, BankTransferPayment, and Payment instances
// each tracked individually in the identity map
```

## UPDATE

When updating an STI entity, the discriminator column is **excluded** from the SET clause. You cannot change a CreditCardPayment into a BankTransferPayment by updating a column -- the discriminator is immutable.

```typescript
const cc = await em.findOne(CreditCardPayment, { where: { id: 1 } });
cc.amount = 200;
await em.save(CreditCardPayment, cc);
```

**Generated SQL (PostgreSQL):**

```sql
UPDATE "payment"
SET "amount" = 200, "cardNumber" = '4111-1111-1111-1111'
WHERE "id" = 1 AND "payment_type" = 'credit_card';
```

**Generated SQL (MySQL):**

```sql
UPDATE `payment`
SET `amount` = 200, `cardNumber` = '4111-1111-1111-1111'
WHERE `id` = 1 AND `payment_type` = 'credit_card';
```

**Returned entity:**

```typescript
// cc is:
CreditCardPayment { id: 1, amount: 200, cardNumber: "4111-1111-1111-1111" }
```

Notice: `payment_type` is **not** in the SET clause. Only business columns appear. The ORM explicitly filters out the discriminator column when building the UPDATE statement.

The WHERE clause carries the discriminator, though. A key that belongs to another subtype's row matches nothing, so `save()` throws `EntityNotFoundError` -- as it does for a key that does not exist -- instead of rewriting that row:

```typescript
await em.save(CreditCardPayment, { id: 2, amount: 1 }); // id 2 is a BankTransferPayment
// EntityNotFoundError: save() attempted an UPDATE but no row matched the
// primary key as a 'CreditCardPayment' row.
```

## DELETE

When deleting a child entity, the discriminator is added to the WHERE clause as a safety guard. This prevents accidentally deleting a row belonging to a different type that happens to have the same ID.

```typescript
await em.delete(CreditCardPayment, { id: 1 });
```

**Generated SQL (PostgreSQL):**

```sql
DELETE FROM "payment"
WHERE "id" = 1 AND "payment_type" = 'credit_card';
```

**Generated SQL (MySQL):**

```sql
DELETE FROM `payment`
WHERE `id` = 1 AND `payment_type` = 'credit_card';
```

Notice: auto-increment IDs are unique across the whole table, so any ID can name another subtype's row -- the discriminator condition is what keeps the write on this subtype. If you delete via the root entity (`em.delete(Payment, { id: 1 })`), no discriminator filter is added.

The other writes through a child follow the same rule: `deleteMany()`, `update()` / `updateMany()`, `increment()` / `decrement()`, `softDelete()` / `restore()` and `createUpdateBuilder()` all add the discriminator to their WHERE clause. `clear()` on a child cannot truncate a table its siblings live in, so it deletes the subtype's rows instead:

```typescript
await em.clear(CreditCardPayment);
```

```sql
DELETE FROM "payment" WHERE "payment_type" = 'credit_card';
```

`em.clear(Payment)` -- the root -- still truncates the whole table.

## Pros and Cons

| Pros | Cons |
|------|------|
| Fastest queries -- no JOINs, no UNIONs | Child columns must be nullable |
| Simplest schema -- one table | Wastes storage on NULL columns |
| Polymorphic queries are trivial | Table grows wide with many child types |
| Single INSERT/UPDATE/DELETE statement | No DB-level NOT NULL enforcement for child fields |
| `instanceof` checks work at runtime | Schema becomes confusing with 10+ child types |
| One index covers the entire hierarchy | Cannot add a UNIQUE constraint on a child-only column across all rows |

## When to Use STI

Use STI when:

- Child-specific columns are **few** (1-3 per child). If each child adds 10 columns, you end up with a 50-column table full of NULLs.
- You need **fast polymorphic queries**. Querying `em.find(Payment, {})` returns all types without JOINs or UNION ALLs.
- The number of child types is **small** (2-5). With 20 types, the single table becomes unwieldy.
- You want **simple schema management**. One table is easier to back up, index, and reason about.

Avoid STI when:

- Child types have **many unique columns**. Switch to [Joined / TPT](./inheritance-tpt.md) for a normalized schema.
- You rarely query the root entity. Switch to [Table Per Class / TPC](./inheritance-tpc.md) for maximum per-type query speed.
- You need **NOT NULL constraints** on child columns. STI forces them nullable.

> **Hint** A practical rule of thumb: if the sum of child-specific columns across all types exceeds 10, consider TPT instead.

## Next Steps

- [Inheritance Mapping](./inheritance-mapping.md) -- Overview of all three strategies (STI, TPT, TPC)
- [Relations](./relations.md) -- @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- [EntityManager](./entity-manager.md) -- find, save, delete, aggregation, pagination
- [Write Buffer](./write-buffer.md) -- Unit of Work pattern with dirty tracking
- [Query Builder](./query-builder.md) -- Complex SQL with JOIN, GROUP BY, subqueries
