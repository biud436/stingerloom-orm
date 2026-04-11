# Inheritance Mapping

**Inheritance mapping** lets you model an OOP class hierarchy -- where child classes share fields with a parent -- as database tables, without duplicating code or schema definitions.

In OOP, `class Child extends Parent` is natural. The child inherits fields and methods automatically, and `instanceof` checks just work. But relational databases live in a different world. Tables are flat collections of rows and columns. There is no concept of "this table inherits from that table," no polymorphism, no `instanceof` in SQL. This gap between the object world and the relational world is called the **Object-Relational Impedance Mismatch**, and bridging it is one of the hardest jobs an ORM does. Inheritance mapping is where that complexity concentrates: the ORM uses techniques like discriminator columns, JOINs, and UNION ALL queries to recreate OOP class hierarchies on top of flat relational tables.

But before diving into decorators, let's understand the problem inheritance mapping solves.

## The Problem

Imagine you are building a payment system. You have three types of payments: credit card, bank transfer, and cryptocurrency. They all share common fields (`id`, `amount`, `createdAt`), but each one also has fields unique to its type:

| Field | CreditCard | BankTransfer | Crypto |
|-------|-----------|-------------|--------|
| `id` | yes | yes | yes |
| `amount` | yes | yes | yes |
| `createdAt` | yes | yes | yes |
| `cardNumber` | yes | -- | -- |
| `expiryDate` | yes | -- | -- |
| `bankCode` | -- | yes | -- |
| `accountNumber` | -- | yes | -- |
| `walletAddress` | -- | -- | yes |

Without inheritance mapping, you have three bad options.

### Option A: Copy-paste the shared columns

You define three separate entities, each repeating `id`, `amount`, and `createdAt`:

```typescript
@Entity()
class CreditCardPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;           // duplicated
  @Column() createdAt!: Date;          // duplicated
  @Column() cardNumber!: string;
  @Column() expiryDate!: string;
}

@Entity()
class BankTransferPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;           // duplicated again
  @Column() createdAt!: Date;          // duplicated again
  @Column() bankCode!: string;
  @Column() accountNumber!: string;
}
```

This violates DRY. If you add a `currency` field to all payments, you must update three classes. If you rename `amount` to `total`, you must rename it in three places. With ten payment types, this becomes a maintenance nightmare.

### Option B: One table with nullable columns

You stuff everything into a single table:

```sql
CREATE TABLE "payment" (
  "id"             SERIAL PRIMARY KEY,
  "amount"         INT NOT NULL,
  "created_at"     TIMESTAMP NOT NULL,
  "type"           VARCHAR(50),
  "card_number"    VARCHAR(255),   -- NULL for non-credit-card
  "expiry_date"    VARCHAR(10),    -- NULL for non-credit-card
  "bank_code"      VARCHAR(50),    -- NULL for non-bank-transfer
  "account_number" VARCHAR(50),    -- NULL for non-bank-transfer
  "wallet_address" VARCHAR(255)    -- NULL for non-crypto
);
```

This wastes space. Every credit card row stores five NULL columns it never uses. With ten payment types and five unique fields each, you have a table with 50+ columns, most of them NULL. The schema is confusing, and there is no way for the database to enforce that `card_number` must be NOT NULL for credit card payments.

### Option C: Manual UNION ALL queries

You create separate tables (one per type) and write UNION ALL queries whenever you need "all payments":

```sql
SELECT id, amount, created_at, 'credit_card' AS type FROM credit_card_payment
UNION ALL
SELECT id, amount, created_at, 'bank_transfer' AS type FROM bank_transfer_payment
UNION ALL
SELECT id, amount, created_at, 'crypto' AS type FROM crypto_payment;
```

This works but is tedious and error-prone. Every time you add a new payment type, you must update every UNION ALL query. If you forget one, that payment type silently disappears from results.

### The Solution

Inheritance mapping automates all three approaches. You define the shared fields once in a parent class, let children extend it, and the ORM handles the table structure and SQL generation for you. Which approach the ORM uses depends on the **strategy** you choose.

## Brief History

This pattern comes from Object-Relational Mapping (ORM) theory. Martin Fowler documented three patterns in *Patterns of Enterprise Application Architecture* (2003): Single Table Inheritance, Class Table Inheritance, and Concrete Table Inheritance. JPA/Hibernate later standardized them as `SINGLE_TABLE`, `JOINED`, and `TABLE_PER_CLASS`. Stingerloom adopts the same three strategies with the same names, so if you have used Hibernate or JPA, this will feel familiar.

## Strategy Comparison

| | Single Table (STI) | Joined (TPT) | Table Per Class (TPC) |
|---|---|---|---|
| **Tables** | 1 shared table | 1 root + N child tables | N independent tables |
| **Polymorphic query** | Fast (no JOINs) | Medium (N LEFT JOINs) | Slow (UNION ALL) |
| **Child INSERT** | 1 statement | 2 statements (root + child) | 1 statement |
| **Child DELETE** | 1 statement | 2 statements (child + root) | 1 statement |
| **Nullable columns** | Required for child fields | Not required | Not required |
| **Schema normalization** | Low | High | Medium |

## Quick Start

Every inheritance hierarchy uses three decorators: `@Inheritance` on the root, `@DiscriminatorColumn` on the root, and `@DiscriminatorValue` on each child.

```typescript
import {
  Entity, PrimaryGeneratedColumn, Column,
  Inheritance, DiscriminatorColumn, DiscriminatorValue,
} from "@stingerloom/orm";

// 1. Root entity: define strategy + discriminator column
@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
}

// 2. Child entities: extend root + set discriminator value
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;
}

@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column({ nullable: true }) bankCode!: string;
}
```

Register all entities (root + children) in your configuration:

```typescript
await em.register({
  type: "postgres",
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

That is it. The ORM now handles discriminator values, table structure, and polymorphic queries automatically.

Each strategy has its own deep-dive guide covering every operation (INSERT, SELECT, UPDATE, DELETE), the exact SQL generated, raw query results, and how they are deserialized into TypeScript objects:

- **[Single Table Inheritance (STI)](./inheritance-sti.md)** -- One shared table with a discriminator column. Fastest queries, simplest schema.
- **[Joined / Table Per Type (TPT)](./inheritance-tpt.md)** -- Root table + child tables linked by PK/FK. Normalized schema, NOT NULL child columns.
- **[Table Per Class (TPC)](./inheritance-tpc.md)** -- Independent tables with duplicated columns. Fastest child queries, slowest polymorphic queries.

## Using Relations with Inheritance

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
@DiscriminatorColumn({ name: "payment_type" })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;

  @Column({ type: "int", nullable: true })
  storeFk!: number;

  @ManyToOne(() => Store, (s) => s.payments, { joinColumn: "storeFk" })
  store!: Store;
}

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;
}
```

Loading relations works the same as regular entities:

```typescript
// Load a child entity with its ManyToOne relation
const cards = await em.find(CreditCardPayment, {
  relations: ["store"],
});
console.log(cards[0].store.name); // "Electronics Store"

// Load from the inverse side -- returns all payment types
const stores = await em.find(Store, {
  relations: ["payments"],
});
console.log(stores[0].payments.length); // 5 (mixed types)
```

::: tip
For TPT strategy, FK columns defined on the root entity are stored in the root table. The ORM automatically qualifies the FK column to the correct table when building JOIN queries.
:::

## Using with WriteBuffer

The WriteBuffer plugin (Unit of Work) transparently supports inheritance entities. `find()`, `findOne()`, and dirty tracking all work correctly with inheritance hierarchies.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin());

const buf = em.buffer();

// findOne returns correctly typed subclass
const cc = await buf.findOne(CreditCardPayment, { where: { amount: 100 } });
cc.amount = 200;

// Dirty tracking works on inherited fields
const result = await buf.flush();
console.log(result.updates); // 1

// Polymorphic queries return correct subclass instances
const all = await buf.find(Payment, {});
all.forEach(p => {
  if (p instanceof CreditCardPayment) {
    console.log(p.cardNumber);
  }
});
```

## QueryBuilder Support

The `SelectQueryBuilder` **fully supports** inheritance mapping. When you use `em.createQueryBuilder(Entity, alias)`, the builder automatically applies the correct inheritance logic for the entity's strategy:

- **STI child**: Adds a `WHERE discriminator = 'value'` clause automatically
- **STI root (polymorphic)**: Returns correct subclass instances via discriminator-based deserialization
- **TPT child**: Auto-joins the parent table with `INNER JOIN` and builds an explicit SELECT combining parent + child columns
- **TPT root (polymorphic)**: `LEFT JOIN`s all child tables, strips column prefixes, and returns correct subclass instances
- **TPC child**: Queries the child's own table directly (no extra logic needed)
- **TPC root (polymorphic)**: Generates a `UNION ALL` subquery across all tables with NULL padding and virtual discriminator

```typescript
// STI: discriminator WHERE is added automatically
const cards = await em
  .createQueryBuilder(CreditCardPayment, "p")
  .where("amount", 100)
  .getMany();
// SELECT "p".* FROM "payment" AS "p"
// WHERE "p"."payment_type" = 'credit_card' AND "p"."amount" = $1

// STI root: polymorphic deserialization
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
// Returns CreditCardPayment, BankTransferPayment, Payment instances

// TPT child: parent table auto-joined
const cards = await em
  .createQueryBuilder(CreditCardPayment, "cc")
  .where("amount", 100)
  .getMany();
// SELECT "cc"."id", "cc"."cardNumber", "payment"."amount"
// FROM "credit_card_payment" AS "cc"
// INNER JOIN "payment" ON "cc"."id" = "payment"."id"
// WHERE "payment"."amount" = $1

// TPC root: UNION ALL auto-generated
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
// SELECT * FROM (
//   SELECT ... FROM "payment" UNION ALL
//   SELECT ... FROM "credit_card_payment" UNION ALL
//   SELECT ... FROM "bank_transfer_payment"
// ) "_tpc"
```

All QueryBuilder methods (`getMany()`, `getOne()`, `getCount()`, `exists()`, `getRawMany()`, `clone()`) work with inheritance. WHERE, ORDER BY, and GROUP BY clauses are supported on polymorphic queries.

## Decorator Reference

| Decorator | Target | Options | Description |
|-----------|--------|---------|-------------|
| `@Inheritance({ strategy })` | Root class | `strategy`: `"SINGLE_TABLE"` \| `"JOINED"` \| `"TABLE_PER_CLASS"` | Declares which mapping strategy the hierarchy uses |
| `@DiscriminatorColumn(opts?)` | Root class | `name` (default `"dtype"`), `type` (default `"varchar"`), `length` (default `31`) | Configures the column that identifies each row's type |
| `@DiscriminatorValue(value)` | Child class | `value`: string | Sets the discriminator string stored for this child type. If omitted, the class name is used. |

> **Hint** `@DiscriminatorColumn` is optional. If you omit it, a column named `"dtype"` with type `VARCHAR(31)` is created by default.

## Strategy Selection Guide

```
Do you need polymorphic queries (em.find(RootEntity))?
  |
  +-- Rarely / Never --> TABLE_PER_CLASS (TPC)
  |                      Each entity is independent. Fastest child queries.
  |
  +-- Yes
       |
       +-- How many child-specific columns?
       |     |
       |     +-- Few (1-3 per child) --> SINGLE_TABLE (STI)
       |     |                           Fastest polymorphic queries. One table.
       |     |
       |     +-- Many (4+ per child) --> JOINED (TPT)
       |                                 Normalized schema. No wasted NULLs.
       |
       +-- Is schema normalization important?
             |
             +-- Yes --> JOINED (TPT)
             +-- No  --> SINGLE_TABLE (STI)
```

## API Summary

| EntityManager Method | Inheritance Support |
|---------------------|---------------------|
| `em.find(RootEntity)` | Polymorphic -- returns correct subclass instances via discriminator |
| `em.find(ChildEntity)` | Scoped -- STI adds `WHERE discriminator`, TPT adds `INNER JOIN`, TPC queries own table |
| `em.findOne(ChildEntity, opts)` | Same scoping as `em.find()` |
| `em.save(ChildEntity, data)` | STI/TPT: auto-sets discriminator. TPT: two-phase insert (root then child) |
| `em.save(ChildEntity, existing)` | TPT: two-phase update (root then child). STI: excludes discriminator from SET |
| `em.delete(ChildEntity, criteria)` | STI: adds discriminator to WHERE. TPT: two-phase delete (child then root) |
| `em.createQueryBuilder(Entity)` | Full support -- STI discriminator WHERE, TPT auto JOIN, TPC UNION ALL, polymorphic deserialization |
| `buf.find(Entity)` | Full support -- delegates to EntityManager |
| `buf.findOne(Entity, opts)` | Full support -- delegates to EntityManager |

## Next Steps

Now that you understand how to model class hierarchies, explore these related topics:

- [Relations](./relations.md) -- @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- [EntityManager](./entity-manager.md) -- find, save, delete, aggregation, pagination
- [Write Buffer](./write-buffer.md) -- Unit of Work pattern with dirty tracking
- [Query Builder](./query-builder.md) -- Complex SQL with JOIN, GROUP BY, subqueries
