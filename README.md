<h1 align="center">Stingerloom ORM</h1>
<p align="center">Decorator-driven TypeScript ORM with multi-tenancy support.</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-1%2C405%20passed-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

---

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column() email!: string;
}

const em = new EntityManager();
await em.register({ type: "postgres", entities: [User], synchronize: true });

await em.save(User, { name: "Alice", email: "alice@example.com" });
await em.find(User, { where: { name: "Alice" } });
```

## Features

- CRUD
- Relations (ManyToOne, OneToMany, ManyToMany, OneToOne)
- Eager & Lazy Loading
- Transactions
- Migrations
- Query Builder
- Multi-tenancy
- Soft Delete
- Upsert
- Cursor Pagination
- N+1 Detection
- EntitySubscriber
- NestJS Integration

## Databases

PostgreSQL · MySQL · SQLite

## Docs

See **[docs/](./docs/README.md)** for full documentation.

## License

[MIT](./LICENSE)
