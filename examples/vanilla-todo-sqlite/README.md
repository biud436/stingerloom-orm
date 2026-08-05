# vanilla-todo-sqlite

Code-first Stingerloom ORM in a plain TypeScript script — no NestJS, no
decorators, no database server. Entities are declared with `defineEntity` and
the `t` field builders, their TypeScript types are inferred with `InferEntity`,
and everything runs against an in-memory SQLite database.

This is the smallest possible proof that the ORM works without the decorator
toolchain: `tsconfig.json` deliberately omits `experimentalDecorators` and
`emitDecoratorMetadata`, and the script runs under `tsx` (esbuild), which never
emits decorator metadata.

## What it shows

- **`defineEntity` + `t` builders** — one declaration is both the table schema
  and the TypeScript type (`src/entities.ts`)
- **`InferEntity`** — row types recovered from the builders, no hand-written
  interfaces
- **Lifecycle hooks without decorators** — `beforeInsert` fills a slug,
  `afterInsert` logs the generated id
- **Relation loading** — `manyToOne` with a declared FK column, loaded via
  `relations: ["project"]`
- **Typed JSON column** — `t.json<{ tags?: string[] }>()` round-trips without
  casts
- **Column features** — enum with default, validation, `version()` optimistic
  lock counter, `deletedAt()` soft delete, `createTimestamp()` /
  `updateTimestamp()`
- **EntityManager API** — `save`, `find` (where / orderBy / take), `findOne`,
  `update`, `softDelete` / `restore`, `count`, `exists`,
  `propagateShutdown`

## Run it

Build the ORM once at the repository root, then:

```bash
cd examples/vanilla-todo-sqlite
pnpm install
pnpm start
```

Expected output (abbreviated):

```
2. Inserts — beforeInsert fills the slug, afterInsert logs
  [hook] afterInsert: todo #1 slug="ship-the-release"
...
5. Soft delete — filtered out by default, visible on request
  visible: 2
  including deleted: 3
```

`pnpm typecheck` runs `tsc --noEmit` with the decorator-free compiler options.

## Files

| File | Purpose |
|------|---------|
| `src/entities.ts` | `Project` and `Todo` entities — schema, hooks, and types in one place |
| `src/main.ts` | Narrated tour: sync, inserts, reads, update, soft delete, queries |
| `tsconfig.json` | Plain strict TypeScript — no decorator compiler flags |
