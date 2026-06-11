# Events & Subscribers

## Why Events Exist

Imagine you have a `User` entity. When a user is created, you need to:
1. Send a welcome email
2. Write an audit log entry
3. Invalidate a cache

You could put all of this logic inside the service that creates the user. But that means your user creation code now knows about emails, audit logs, and caches. Every time you add a new side effect, you modify the same service. The code becomes tangled.

Events solve this by **decoupling** the thing that happens (user was created) from the things that react to it (send email, write log, clear cache). The creator publishes an event. The listeners react independently. They do not know about each other.

This is the same idea as a newspaper. The newspaper publishes the news. Subscribers read it and take their own actions. The newspaper does not know or care what each subscriber does with the information.

Stingerloom provides three levels of event handling, from simplest to most powerful:

1. **Lifecycle hooks** (`@BeforeInsert`, `@AfterUpdate`, ...) -- decorators on the entity class itself
2. **Global event listeners** (`em.on()`) -- callbacks that fire for all entities
3. **Entity subscribers** (`EntitySubscriber`) -- classes that encapsulate event logic for a specific entity

---

## Lifecycle Hooks -- Events on the Entity Itself

The simplest way to react to entity lifecycle events is with decorators directly on the entity class. No registration needed -- the ORM discovers them automatically through metadata.

```typescript
import { Entity, Column, BeforeInsert, AfterUpdate } from "@stingerloom/orm";

@Entity()
export class Post {
  @Column()
  title!: string;

  @Column()
  slug!: string;

  @BeforeInsert()
  generateSlug() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }

  @AfterUpdate()
  logUpdate() {
    console.log(`Post "${this.title}" was updated`);
  }
}
```

Here is the SQL timeline showing exactly when each hook fires:

```
  Your code:  em.save(Post, { title: "Hello World" })
      |
      v
  @BeforeInsert fires  -->  generateSlug() runs
      |                     this.slug is now "hello-world"
      v
  SQL executes:  INSERT INTO "posts" ("title", "slug") VALUES ('Hello World', 'hello-world');
      |
      v
  @AfterInsert fires   -->  (if you had one, it would run here)
```

The key insight: **before hooks can mutate data** (they run before the SQL), while **after hooks are for side effects** (the SQL has already executed, the data is committed).

### Available Hooks

| Decorator | When it fires | Can mutate data? | Use case |
|-----------|--------------|-----------------|----------|
| `@BeforeInsert()` | Before `INSERT` SQL | Yes | Generate slugs, set defaults, validate |
| `@AfterInsert()` | After `INSERT` SQL | No (already saved) | Send notifications, log creation |
| `@BeforeUpdate()` | Before `UPDATE` SQL | Yes | Recalculate derived fields, validate |
| `@AfterUpdate()` | After `UPDATE` SQL | No (already saved) | Log changes, trigger webhooks |
| `@BeforeDelete()` | Before `DELETE` SQL | No | Validate permissions, check constraints |
| `@AfterDelete()` | After `DELETE` SQL | No (already deleted) | Clean up related resources |

### When to Use Hooks vs. Other Approaches

Hooks are best for logic that is **intrinsic to the entity** -- things that should always happen regardless of which service triggers the save. Generating a slug from a title is a good example: no matter how a Post is created, it should always have a slug.

If the logic is about a **reaction to the entity** (sending an email, updating a cache), use a subscriber or global listener instead. The entity should not know about email services.

---

## Global Event Listeners -- React to Everything

Global listeners fire for **every entity** in the system. They are registered on the EntityManager with `em.on()`.

```typescript
// Log every insert across all entities
em.on("afterInsert", ({ entity, data }) => {
  console.log(`[AUDIT] ${entity.name} created:`, data);
});

// Log every delete across all entities
em.on("afterDelete", ({ entity, data }) => {
  console.log(`[AUDIT] ${entity.name} deleted:`, data);
});
```

The SQL timeline for a global listener:

```
  Your code:  em.save(User, { name: "Alice" })
      |
      v
  "beforeInsert" listeners fire  (all registered listeners, sequentially)
      |
      v
  SQL executes:  INSERT INTO "users" ("name") VALUES ('Alice') RETURNING "id";
      |
      v
  "afterInsert" listeners fire   (all registered listeners, sequentially)
```

### Managing Listeners

```typescript
// Register a listener (returns nothing)
em.on("afterInsert", listener);

// Remove a specific listener
em.off("afterInsert", listener);

// Remove ALL listeners for ALL events
em.removeAllListeners();
```

### Available Events

| Event | Timing |
|-------|--------|
| `beforeInsert` | Before INSERT |
| `afterInsert` | After INSERT |
| `beforeUpdate` | Before UPDATE |
| `afterUpdate` | After UPDATE |
| `beforeDelete` | Before DELETE |
| `afterDelete` | After DELETE |

### When to Use Global Listeners

Global listeners are ideal for **cross-cutting concerns** that apply to every entity:

- **Audit logging** -- record every change to every table
- **Metrics** -- count inserts/updates/deletes per second
- **Debugging** -- log all database operations during development

If you need to react to a specific entity only (e.g., invalidate a cache when User changes), use an EntitySubscriber instead.

---

## EntitySubscriber -- Per-Entity Event Classes

`EntitySubscriber` is the most powerful approach. It lets you encapsulate all event logic for a single entity into a dedicated class. Unlike global listeners, subscribers only receive events for the entity they care about.

### A Complete Example: Audit Trail

Here is a subscriber that logs every change to the User entity:

```typescript
// user-audit.subscriber.ts
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "@stingerloom/orm";
import { User } from "./user.entity";

class UserAuditSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User; // Only receive events for User -- not Post, not Comment, only User
  }

  async beforeInsert(event: InsertEvent<User>) {
    // Runs BEFORE the INSERT SQL.
    // You can mutate event.entity here to change what gets inserted.
    console.log("About to create user:", event.entity);
  }

  async afterInsert(event: InsertEvent<User>) {
    // Runs AFTER the INSERT SQL.
    // The user is already in the database. Use this for side effects.
    console.log("User created:", event.entity);
    await this.writeAuditLog("INSERT", event.entity);
  }

  async afterUpdate(event: UpdateEvent<User>) {
    console.log("User updated:", event.entity);
    await this.writeAuditLog("UPDATE", event.entity);
  }

  async afterDelete(event: DeleteEvent<User>) {
    console.log("User deleted, criteria:", event.criteria);
    await this.writeAuditLog("DELETE", { criteria: event.criteria });
  }

  private async writeAuditLog(action: string, data: any) {
    // Write to an audit_logs table, send to an external service, etc.
  }
}
```

### The SQL Timeline with a Subscriber

```
  Your code:  em.save(User, { name: "Alice", email: "alice@example.com" })
      |
      v
  UserAuditSubscriber.beforeInsert() fires
      |  (event.entity = { name: "Alice", email: "alice@example.com" })
      |  (you can mutate event.entity here)
      v
  SQL executes:  INSERT INTO "users" ("name", "email")
                 VALUES ('Alice', 'alice@example.com')
                 RETURNING "id";
      |
      v
  UserAuditSubscriber.afterInsert() fires
      |  (event.entity = { id: 1, name: "Alice", email: "alice@example.com" })
      |  (side effects only -- the row is already committed)
      v
  Return to your code
```

### Registration

```typescript
// Register the subscriber
em.addSubscriber(new UserAuditSubscriber());

// Unregister later if needed
em.removeSubscriber(subscriber);
```

### All Subscriber Events

EntitySubscriber supports a wider set of events than global listeners, including transaction lifecycle events:

| Method | When it fires | Use case |
|--------|--------------|----------|
| `afterLoad(entity)` | After loading an entity from the database | Decrypt fields, compute derived values |
| `beforeInsert(event)` | Before INSERT | Validate, enrich, or transform data |
| `afterInsert(event)` | After INSERT | Audit log, send welcome email |
| `beforeUpdate(event)` | Before UPDATE | Validate changes, track field diffs |
| `afterUpdate(event)` | After UPDATE | Invalidate cache, notify subscribers |
| `beforeDelete(event)` | Before DELETE | Check permissions, prevent protected deletions |
| `afterDelete(event)` | After DELETE | Clean up files, remove from search index |
| `beforeTransactionStart()` | Before BEGIN | Diagnostics, logging |
| `afterTransactionStart()` | After BEGIN | Diagnostics, logging |
| `beforeTransactionCommit()` | Before COMMIT | Final validation, batch side effects |
| `afterTransactionCommit()` | After COMMIT | Publish domain events to message queue |
| `beforeTransactionRollback()` | Before ROLLBACK | Logging |
| `afterTransactionRollback()` | After ROLLBACK | Cleanup, alerting |

All methods are optional -- implement only the ones you need.

### The afterLoad Guarantee

`afterLoad` fires for **every read path that returns entities** -- this is a guarantee you can build on:

| Read path | Fires `afterLoad`? |
|-----------|--------------------|
| `find()` / `findOne()` | Yes |
| Cursor pagination (`findWithCursor()`) | Yes |
| Query builder `getMany()` / `getOne()` / `getManyAndCount()` / `paginate()` | Yes (entity results) |
| `getRawMany()` / `getPartialMany()` | No -- raw and partial reads never fire it |

If your subscriber decrypts a field or computes a derived value in `afterLoad`, you can rely on it running no matter how the entity was loaded -- switching a service from `find()` to a query builder does not silently skip the hook. Conversely, raw and partial projections are guaranteed to stay untouched.

### Concrete Use Cases

**Cache invalidation:**
```typescript
class ProductCacheSubscriber implements EntitySubscriber<Product> {
  listenTo() { return Product; }

  async afterUpdate(event: UpdateEvent<Product>) {
    await redis.del(`product:${event.entity.id}`);
  }

  async afterDelete(event: DeleteEvent<Product>) {
    await redis.del(`product:${event.criteria.id}`);
  }
}
```

**Sending notifications:**
```typescript
class OrderNotificationSubscriber implements EntitySubscriber<Order> {
  listenTo() { return Order; }

  async afterInsert(event: InsertEvent<Order>) {
    await emailService.send({
      to: event.entity.customerEmail,
      subject: "Order confirmed",
      body: `Your order #${event.entity.id} has been placed.`,
    });
  }
}
```

**Domain event publishing (after commit only):**
```typescript
class PaymentEventSubscriber implements EntitySubscriber<Payment> {
  listenTo() { return Payment; }

  async afterTransactionCommit() {
    // Only publish to the message queue AFTER the transaction is committed.
    // If you published in afterInsert and the transaction rolled back,
    // consumers would process an event for data that does not exist.
    await messageQueue.publish("payment.completed", { ... });
  }
}
```

---

## NestJS Integration

In NestJS, register subscribers during module initialization using the `OnModuleInit` lifecycle hook:

```typescript
import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectEntityManager } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  onModuleInit() {
    // Register all subscribers when the module starts
    this.em.addSubscriber(new UserAuditSubscriber());
    this.em.addSubscriber(new ProductCacheSubscriber());
    this.em.addSubscriber(new OrderNotificationSubscriber());
  }
}
```

---

## Choosing the Right Approach

Here is a decision tree to help you pick:

**"Should this logic always happen for this entity, regardless of who triggers the save?"**
- Yes -- use a **lifecycle hook** (`@BeforeInsert`, etc.) on the entity class.
- Example: generating a slug, setting a default status.

**"Should this logic run for ALL entities in the system?"**
- Yes -- use a **global listener** (`em.on()`).
- Example: audit logging every change, counting operations for metrics.

**"Should this logic run for ONE specific entity, and it involves external systems?"**
- Yes -- use an **EntitySubscriber**.
- Example: sending emails on User creation, invalidating cache on Product update.

Summary table:

| Need | Use |
|------|-----|
| Mutate entity data before save | `@BeforeInsert()` / `@BeforeUpdate()` hooks |
| React to all entities globally (logging, metrics) | `em.on()` |
| React to a specific entity (audit, cache, notifications) | `EntitySubscriber` |
| React to transaction lifecycle (commit, rollback) | `EntitySubscriber` |

---

## Next Steps

- [Entities](./entities.md) -- Entity definitions, columns, and validation decorators
- [Transactions](./transactions.md) -- Transaction management and isolation levels
- [API Reference](./api-reference.md) -- EntitySubscriber type signatures
