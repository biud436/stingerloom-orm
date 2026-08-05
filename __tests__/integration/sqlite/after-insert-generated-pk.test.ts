/**
 * afterInsert contract: "the entity now has its ID". Hooks, subscribers, and
 * the event payload all receive the original input instance, so the
 * DB-generated key must be visible on it when they fire. Regression test for
 * the WriteExecutor insert paths that ran hooks before writing the key back
 * (surfaced by examples/vanilla-todo-sqlite, which logs the id in afterInsert
 * exactly the way the define-entity docs showcase).
 */
import "reflect-metadata";
import { defineEntity, t } from "../../../src/schema";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

const seenIds: Array<number | undefined> = [];

const Note = defineEntity(
  "aigp_notes",
  {
    id: t.int().primary().generated(),
    title: t.varchar(120),
  },
  {
    hooks: {
      afterInsert(note) {
        seenIds.push(note.id);
      },
    },
  },
);

describe("[Integration] SQLite: afterInsert sees the generated PK", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [Note] });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  it("assigns the auto-increment id to the input instance before the hook fires", async () => {
    seenIds.length = 0;
    const input = new Note({ title: "first" });
    const saved = await em.save(Note, input);

    expect(saved.id).toBeGreaterThan(0);
    expect(seenIds).toEqual([saved.id]);
    // The original input instance carries the id afterwards as well.
    expect(input.id).toBe(saved.id);
  });
});
