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
pnpm install

# Build
pnpm build
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

  @Column()
  name!: string;

  @Column()
  age!: number;

  @Column()
  breed!: string;

  @Column({
    type: "datetime",
    nullable: false,
    length: 6,
  })
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

```typescript
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { StinglerloomOrmModule } from "./stingerloom-orm/stingerloom-orm.module";
import { CatsModule } from "./cats/cats.module";

@Module({
  imports: [
    // Load environment variables
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    CatsModule,
    // Initialize database with forRoot pattern
    StinglerloomOrmModule.forRoot({
      type: "mysql",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306"),
      username: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "password",
      database: process.env.DB_NAME || "cats_db",
      entities: [__dirname + "/**/*.entity{.ts,.js}"],
      synchronize: true, // Auto-create tables (development only!)
      logging: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

### Using forFeature() in Feature Modules

```typescript
// cats.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "../stingerloom-orm/stingerloom-orm.module";
import { CatsService } from "./cats.service";
import { CatsController } from "./cats.controller";
import { Cat } from "./cat.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Cat])],
  controllers: [CatsController],
  providers: [CatsService],
})
export class CatsModule {}
```

### Injecting Repository in Service

```typescript
// cats.service.ts
import { Injectable } from "@nestjs/common";
import { BaseRepository } from "stingerloom-orm";
import { InjectRepository } from "../stingerloom-orm/inject-repository.decorator";
import { Cat } from "./cat.entity";
import { CreateCatDto } from "./dto/create-cat.dto";

@Injectable()
export class CatsService {
  constructor(
    @InjectRepository(Cat) private readonly catRepository: BaseRepository<Cat>,
  ) {}

  async create(createCatDto: CreateCatDto): Promise<Cat> {
    const cat = new Cat();
    cat.name = createCatDto.name;
    cat.age = createCatDto.age;
    cat.breed = createCatDto.breed;
    cat.createdAt = new Date();

    const result = await this.catRepository.save(cat);
    if (!result) {
      throw new Error("Failed to create cat");
    }
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Cat[]> {
    return await this.catRepository.find({});
  }

  async findOne(id: number): Promise<Cat | null> {
    return await this.catRepository.findOne({
      where: { id } as any,
    });
  }

  async update(id: number, updateCatDto: Partial<CreateCatDto>): Promise<Cat> {
    const cat = await this.findOne(id);
    if (!cat) {
      throw new Error(`Cat with ID ${id} not found`);
    }

    Object.assign(cat, updateCatDto);
    const result = await this.catRepository.save(cat);
    return Array.isArray(result) ? result[0] : result;
  }

  async remove(id: number): Promise<void> {
    await this.catRepository.delete({ id } as any);
  }
}
```

### Custom InjectRepository Decorator

```typescript
// stingerloom-orm/inject-repository.decorator.ts
import { Inject } from "@nestjs/common";
import { makeInjectRepositoryToken } from "./stingerloom-orm.module";
import { ClazzType } from "stingerloom-orm";

export const InjectRepository = (
  entity: ClazzType<unknown>,
): ParameterDecorator => {
  return Inject(makeInjectRepositoryToken(entity));
};
```

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
