import { defineEntity, t, InferEntity } from "@stingerloom/orm";

/**
 * Code-first entities: one declaration is the table schema AND the TypeScript
 * type. No classes to hand-write, no decorators, no experimentalDecorators /
 * emitDecoratorMetadata compiler flags.
 */

export const Project = defineEntity("projects", {
  id: t.int().primary().generated(),
  name: t.varchar(120).unique(),
  createdAt: t.datetime().createTimestamp(),
});

export const Todo = defineEntity(
  "todos",
  {
    id: t.int().primary().generated(),
    title: t.varchar(200).validate([
      { constraint: "notNull" },
      { constraint: "minLength", value: 2 },
    ]),
    // Filled by the beforeInsert hook when not provided.
    slug: t.varchar(200).nullable(),
    priority: t.enum(["low", "medium", "high"]).default("medium"),
    done: t.boolean().default(false),
    // Typed JSON column — reads back as { tags?: string[] }, not `unknown`.
    meta: t.json<{ tags?: string[] }>().nullable(),
    // Physical FK column + the relation that rides on it.
    projectId: t.int().name("project_id"),
    project: t.manyToOne(() => Project, { joinColumn: "project_id" }),
    version: t.int().version(),
    deletedAt: t.datetime().deletedAt(),
    createdAt: t.datetime().createTimestamp(),
    updatedAt: t.datetime().updateTimestamp(),
  },
  {
    // Lifecycle hooks without decorators — declared next to the schema.
    hooks: {
      beforeInsert(todo) {
        todo.slug ??= todo.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
      },
      afterInsert(todo) {
        console.log(`  [hook] afterInsert: todo #${todo.id} slug="${todo.slug}"`);
      },
    },
  },
);

// The row types, inferred straight from the builders above.
export type Project = InferEntity<typeof Project>;
export type Todo = InferEntity<typeof Todo>;
