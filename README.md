# Stingerloom ORM

A standalone, framework-agnostic TypeScript ORM extracted from the Stingerloom framework. Built with decorators, reflection, and dependency injection for clean, type-safe database operations.

## Features

- **Framework-agnostic** - Works with NestJS, Express, Fastify, or any Node.js framework
- **TypeScript First** - Full type safety with decorators and reflection metadata
- **Decorator-based Entities** - Clean entity definitions with `@Entity`, `@Column`, `@PrimaryGeneratedColumn`
- **Repository Pattern** - Type-safe repository with find, save, delete operations
- **Entity Relationships** - Support for `@ManyToOne` relationships
- **Transaction Support** - Built-in transaction management
- **MySQL/MariaDB Support** - Native MySQL and MariaDB support via mysql2
- **Metadata-driven** - Configuration stored in metadata following Stingerloom framework pattern
- **Well-tested** - 134 unit tests passing

## Installation

> **Note**: This package is not yet published to npm. Currently in development.

### For Development

```bash
# Clone the repository
git clone https://github.com/biud436/stingerloom-orm.git
cd stingerloom-orm

# Install dependencies
npm install

# Build
npm run build
```

### Required Dependencies

- `reflect-metadata` - For decorator metadata reflection
- `mysql2` - MySQL database driver
- `typedi` - Dependency injection (scanners use `@Service()` for auto-initialization)

### After npm Publication

Once published, you will be able to install via:

```bash
npm install stingerloom-orm mysql2 reflect-metadata typedi
```

## Quick Start

### 1. Define Entity

```typescript
import { Entity, Column, PrimaryGeneratedColumn } from "stingerloom-orm";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255, nullable: false })
  name!: string;

  @Column({ type: "int", length: 11, nullable: false })
  age!: number;

  @Column({ type: "varchar", length: 255, nullable: false })
  breed!: string;

  @Column({ type: "datetime", name: "created_at", nullable: false })
  createdAt!: Date;
}
```

### 2. Initialize EntityManager

```typescript
import "reflect-metadata"; // Required at entry point
import { EntityManager } from "stingerloom-orm";
import { Cat } from "./entities/Cat";

const entityManager = new EntityManager();

await entityManager.register({
  type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [Cat],
  synchronize: true, // Auto-create tables (dev only!)
  logging: true,
});
```

### 3. Use Repository

```typescript
const catRepository = entityManager.getRepository(Cat);

// Create
await catRepository.save({
  name: "Whiskers",
  age: 3,
  breed: "Persian",
  createdAt: new Date(),
});

// Find
const cats = await catRepository.find({});
const cat = await catRepository.findOne({ where: { id: 1 } });
```

## Examples

Complete working examples with detailed documentation:

- **[NestJS Cats API](./examples/nestjs-cats/)** - Full CRUD REST API with DatabaseModule.forRoot() pattern
- More examples in **[examples/](./examples/)** directory

## Testing

```bash
npm test              # Run tests
npm test -- --coverage  # With coverage
```

## Links

- [Examples](./examples/)
- [NestJS Example](./examples/nestjs-cats/)

## License

MIT
