# Events & Subscribers

Stingerloom provides two levels of event handling: global event listeners via `em.on()` and per-entity subscribers via `EntitySubscriber`.

## Global Event Listeners

Register logic that runs whenever any entity is created, updated, or deleted.

```typescript
// Register listener
em.on("afterInsert", ({ entity, data }) => {
  console.log(`${entity.name} created:`, data);
});

// Remove a specific listener
em.off("afterInsert", listener);

// Remove all listeners
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

Global listeners receive events for **all** entities. When you need to react to a specific entity only, use `EntitySubscriber`.

## EntitySubscriber — Per-Entity Events

`EntitySubscriber` lets you encapsulate event logic for a single entity class. This is the recommended pattern for audit trails, cache invalidation, and domain-specific side effects.

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
    return User; // Only receive events for this entity
  }

  async afterInsert(event: InsertEvent<User>) {
    console.log("User created:", event.entity);
  }

  async afterUpdate(event: UpdateEvent<User>) {
    console.log("User updated:", event.entity);
  }

  async afterDelete(event: DeleteEvent<User>) {
    console.log("User deleted, criteria:", event.criteria);
  }
}
```

### Registration

```typescript
// Register
em.addSubscriber(new UserAuditSubscriber());

// Unregister
em.removeSubscriber(subscriber);
```

### Subscriber Events

EntitySubscriber supports a wider set of events than global listeners, including transaction lifecycle:

| Method | Timing |
|--------|--------|
| `afterLoad(entity)` | After loading entity from DB |
| `beforeInsert(event)` / `afterInsert(event)` | Before/after INSERT |
| `beforeUpdate(event)` / `afterUpdate(event)` | Before/after UPDATE |
| `beforeDelete(event)` / `afterDelete(event)` | Before/after DELETE |
| `beforeTransactionStart()` / `afterTransactionStart()` | Before/after transaction start |
| `beforeTransactionCommit()` / `afterTransactionCommit()` | Before/after COMMIT |
| `beforeTransactionRollback()` / `afterTransactionRollback()` | Before/after ROLLBACK |

All methods are optional — implement only what you need.

## Lifecycle Hooks

For simple per-entity logic that doesn't need a separate class, use decorator-based lifecycle hooks directly on the entity:

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

### Available Hooks

| Decorator | Timing |
|-----------|--------|
| `@BeforeInsert()` | Before INSERT — mutate entity before saving |
| `@AfterInsert()` | After INSERT |
| `@BeforeUpdate()` | Before UPDATE — mutate entity before updating |
| `@AfterUpdate()` | After UPDATE |
| `@BeforeDelete()` | Before DELETE |
| `@AfterDelete()` | After DELETE |

## NestJS Integration

In NestJS, register subscribers during module initialization:

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
    this.em.addSubscriber(new UserAuditSubscriber());
  }
}
```

## Choosing the Right Approach

| Need | Use |
|------|-----|
| React to all entities globally (logging, metrics) | `em.on()` |
| React to a specific entity (audit, cache, domain logic) | `EntitySubscriber` |
| Mutate entity data before save | `@BeforeInsert()` / `@BeforeUpdate()` hooks |
| Transaction lifecycle awareness | `EntitySubscriber` |

## Next Steps

- [Entities](./entities.md) — Lifecycle hooks and validation decorators
- [Logging & Diagnostics](./logging.md) — N+1 detection and slow query tracking
- [API Reference](./api-reference.md) — EntitySubscriber type signatures
