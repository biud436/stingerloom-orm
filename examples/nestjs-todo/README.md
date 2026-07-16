# NestJS Todo (MySQL) — Stingerloom ORM Example

A minimal NestJS Todo API showcasing Stingerloom ORM on MySQL. This is the
smallest possible reference for the NestJS module wiring — one entity, one
module, one service — plus a taste of the **Buffer Plugin (Unit of Work)**.

## Why this example?

- **Fewest moving parts.** A single `Todo` entity with `@Entity` / `@Column` /
  `@PrimaryGeneratedColumn`, one repository, no relations — ideal for diffing
  against your own first integration.
- **Buffer Plugin in action.** `PATCH /todos/batch/complete` loads several
  todos through `em.buffer()`, mutates them in memory, and flushes all
  updates in a single transaction (`BEGIN` → `UPDATE` × N → `COMMIT`).
- **Soft delete + lifecycle hooks.** `@DeletedAt` filtering and
  `@BeforeInsert` / `@BeforeUpdate` timestamp hooks on a tiny surface.
- **Same domain as `nestjs-todo-sqlite`** — switch the `type` and you can
  compare the MySQL and SQLite wiring side by side.

## Prerequisites

- Node.js 18+
- pnpm
- A running MySQL server with a `todo_db` database (or set `DB_NAME`)

## Quick Start

```bash
# 1. Build the ORM (only needed when running from the monorepo)
cd /path/to/stingerloom-orm
pnpm build

# 2. Install + start
cd examples/nestjs-todo
pnpm install
pnpm start         # or pnpm start:dev for watch mode
```

The API is now live at `http://localhost:3001`, with Swagger UI at
`http://localhost:3001/api-docs`. `synchronize: true` creates the `todo`
table on boot.

## Endpoints

`Todo` schema: `id` (auto), `title`, `description?`, `completed` (default
`false`), `createdAt`, `updatedAt`, `deletedAt` (soft-delete sentinel).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/todos` | Create a todo (`{ title, description? }`) |
| GET | `/todos` | List todos (excludes soft-deleted) |
| GET | `/todos/:id` | Get one — 404 if absent or soft-deleted |
| PATCH | `/todos/:id` | Update fields (e.g. `{ completed: true }`) |
| PATCH | `/todos/batch/complete` | Complete many (`{ ids: [1, 2, 3] }`) in one transaction via the Buffer Plugin |
| DELETE | `/todos/:id` | **Soft** delete — subsequent `GET` returns 404 |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | MySQL host |
| `DB_PORT` | `3306` | MySQL port |
| `DB_USER` | `root` | MySQL user |
| `DB_PASSWORD` | `password` | MySQL password |
| `DB_NAME` | `todo_db` | Database name (must exist) |
| `PORT` | `3001` | HTTP port |

## Tests

E2E tests live in `test/todos.e2e-spec.ts` and cover the full create →
update → batch complete → soft-delete → 404 flow (10 tests). They boot the
real app, so MySQL must be reachable with the configuration above:

```bash
pnpm test          # alias of test:e2e
pnpm test:e2e
```

## How it wires up

```ts
// src/app.module.ts
StingerloomOrmModule.forRoot({
  type: "mysql",
  // host / port / username / password / database from env
  entities: [__dirname + "/**/*.entity{.ts,.js}"],
  synchronize: true,
  plugins: [bufferPlugin()],   // enables em.buffer() Unit of Work
})
```

The batch endpoint then uses the plugin like this:

```ts
// src/todos/todos.service.ts
const buf = this.em.buffer();
for (const id of dto.ids) {
  const todo = await buf.findOne(Todo, { where: { id } }); // auto-tracked
  todo.completed = true;
}
return buf.flush(); // one transaction for every dirty entity
```
