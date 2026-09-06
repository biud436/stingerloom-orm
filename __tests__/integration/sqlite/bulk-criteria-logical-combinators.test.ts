/**
 * Bulk-write criteria accept the same logical combinators as reads (V5-T2-1).
 *
 * `resolveWhereClause` has always understood `AND` / `OR` / `NOT`, and the
 * four criteria-based writes (delete / updateMany / softDelete / restore)
 * feed their criteria through it — but the key guard in front of them
 * treated every top-level key as a column name, so `{ OR: [...] }` was
 * rejected with `Unknown column "OR"` and a misleading "Valid columns" list.
 * These cases run the real SQL against SQLite and assert the surviving rows,
 * pin the typo message for a column nested inside a combinator, and keep the
 * SET payload of updateMany closed to combinators.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";
import { DeleteWithoutConditionsError } from "../../../src/errors/DeleteWithoutConditionsError";

@Entity({ name: "bcl_items" })
class BclItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 20 })
  status!: string;

  @Column({ type: "int" })
  priority!: number;

  @Column({ type: "varchar", length: 20, nullable: true })
  tag?: string | null;

  @DeletedAt()
  deletedAt?: Date | null;
}

const SEED: Array<Pick<BclItem, "status" | "priority" | "tag">> = [
  { status: "open", priority: 1, tag: "a" }, // id 1
  { status: "open", priority: 5, tag: null }, // id 2
  { status: "closed", priority: 3, tag: "a" }, // id 3
  { status: "archived", priority: 9, tag: "b" }, // id 4
  { status: "closed", priority: 7, tag: null }, // id 5
];

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("[Integration] SQLite: logical combinators in bulk-write criteria", () => {
  let em: EntityManager;

  const liveIds = async () =>
    (await em.find(BclItem, { orderBy: { id: "ASC" } })).map((r) => r.id);
  const allIds = async () =>
    (await em.find(BclItem, { orderBy: { id: "ASC" }, withDeleted: true })).map(
      (r) => r.id,
    );

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [BclItem] });
  });

  beforeEach(async () => {
    await em.query("DELETE FROM bcl_items");
    await em.query("DELETE FROM sqlite_sequence WHERE name = 'bcl_items'");
    for (const row of SEED) await em.save(BclItem, { ...row });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  describe("delete()", () => {
    it("OR", async () => {
      const result = await em.delete(BclItem, {
        OR: [{ status: "open" }, { status: "archived" }],
      });
      expect(result.affected).toBe(3);
      expect(await liveIds()).toEqual([3, 5]);
    });

    it("AND", async () => {
      const result = await em.delete(BclItem, {
        AND: [{ status: "closed" }, { priority: { gt: 5 } }],
      });
      expect(result.affected).toBe(1);
      expect(await liveIds()).toEqual([1, 2, 3, 4]);
    });

    it("NOT", async () => {
      const result = await em.delete(BclItem, { NOT: { status: "open" } });
      expect(result.affected).toBe(3);
      expect(await liveIds()).toEqual([1, 2]);
    });

    it("nested: AND of an OR and a NOT", async () => {
      const result = await em.delete(BclItem, {
        AND: [
          { OR: [{ status: "open" }, { status: "closed" }] },
          { NOT: { priority: { gte: 5 } } },
        ],
      });
      expect(result.affected).toBe(2);
      expect(await liveIds()).toEqual([2, 4, 5]);
    });

    it("combinator next to a plain column is AND-ed with it", async () => {
      const result = await em.delete(BclItem, {
        status: "closed",
        OR: [{ priority: { lt: 5 } }, { tag: "zzz" }],
      });
      expect(result.affected).toBe(1);
      expect(await liveIds()).toEqual([1, 2, 4, 5]);
    });

    it("typo inside AND is reported as a criteria column with a suggestion", async () => {
      const error = await captureError(() =>
        em.delete(BclItem, {
          AND: [{ status: "closed" }, { priorty: { gt: 5 } }],
        } as never),
      );
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Unknown column "priorty" in "criteria" for entity "BclItem". Did you mean "priority"?',
      );
      expect(error.message).toContain("Valid columns: id, status, priority, tag, deletedAt");
      expect(await liveIds()).toEqual([1, 2, 3, 4, 5]);
    });

    it("a combinator that resolves to nothing still trips the table-wide guard", async () => {
      await expect(em.delete(BclItem, { OR: [] })).rejects.toThrow(
        DeleteWithoutConditionsError,
      );
      expect(await liveIds()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("updateMany()", () => {
    const taggedX = async () =>
      (await em.find(BclItem, { where: { tag: "x" }, orderBy: { id: "ASC" } })).map(
        (r) => r.id,
      );

    it("OR", async () => {
      const result = await em.updateMany(
        BclItem,
        { tag: "x" },
        { where: { OR: [{ status: "open" }, { status: "archived" }] } },
      );
      expect(result.affected).toBe(3);
      expect(await taggedX()).toEqual([1, 2, 4]);
    });

    it("AND", async () => {
      const result = await em.updateMany(
        BclItem,
        { tag: "x" },
        { where: { AND: [{ status: "closed" }, { priority: { gt: 5 } }] } },
      );
      expect(result.affected).toBe(1);
      expect(await taggedX()).toEqual([5]);
    });

    it("NOT", async () => {
      const result = await em.updateMany(
        BclItem,
        { tag: "x" },
        { where: { NOT: { status: "open" } } },
      );
      expect(result.affected).toBe(3);
      expect(await taggedX()).toEqual([3, 4, 5]);
    });

    it("nested: OR containing a NOT", async () => {
      const result = await em.updateMany(
        BclItem,
        { tag: "x" },
        {
          where: {
            OR: [{ priority: { gte: 9 } }, { NOT: { status: { in: ["open", "closed"] } } }],
          },
        },
      );
      expect(result.affected).toBe(1);
      expect(await taggedX()).toEqual([4]);
    });

    it("update() sugar forwards the combinator", async () => {
      const result = await em.update(
        BclItem,
        { OR: [{ id: 1 }, { id: 5 }] },
        { tag: "x" },
      );
      expect(result.affected).toBe(2);
      expect(await taggedX()).toEqual([1, 5]);
    });

    it("typo inside OR is reported as a where column with a suggestion", async () => {
      const error = await captureError(() =>
        em.updateMany(
          BclItem,
          { tag: "x" },
          { where: { OR: [{ status: "open" }, { statu: "closed" }] } as never },
        ),
      );
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Unknown column "statu" in "where" for entity "BclItem". Did you mean "status"?',
      );
      expect(await taggedX()).toEqual([]);
    });

    it("a combinator that resolves to nothing still trips the table-wide guard", async () => {
      await expect(
        em.updateMany(BclItem, { tag: "x" }, { where: { OR: [] } }),
      ).rejects.toThrow(DeleteWithoutConditionsError);
      expect(await taggedX()).toEqual([]);
    });

    it("a where whose only value is undefined trips the guard instead of updating every live row", async () => {
      // Before the post-resolution guard, the key-count check passed and the
      // soft-delete predicate the ORM appends became the whole WHERE.
      await expect(
        em.updateMany(BclItem, { tag: "x" }, { where: { status: undefined } }),
      ).rejects.toThrow(DeleteWithoutConditionsError);
      expect(await taggedX()).toEqual([]);
    });

    it("increment() forwards the combinator through update()", async () => {
      const result = await em.increment(
        BclItem,
        { OR: [{ status: "open" }, { NOT: { tag: null } }] },
        "priority",
        10,
      );
      expect(result.affected).toBe(4);
      const rows = await em.find(BclItem, { orderBy: { id: "ASC" } });
      expect(rows.map((r) => r.priority)).toEqual([11, 15, 13, 19, 7]);
    });

    it("rejects a combinator in the SET payload", async () => {
      const error = await captureError(() =>
        em.updateMany(
          BclItem,
          { OR: [{ tag: "x" }] } as never,
          { where: { id: 1 } },
        ),
      );
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Logical combinator "OR" is not allowed in the update data for entity "BclItem".',
      );
      expect(error.message).toContain("put them in options.where");
      expect(await taggedX()).toEqual([]);
    });

    it("still rejects an unknown column in the SET payload", async () => {
      const error = await captureError(() =>
        em.updateMany(BclItem, { tagg: "x" } as never, { where: { id: 1 } }),
      );
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Unknown column "tagg" in "data" for entity "BclItem". Did you mean "tag"?',
      );
    });
  });

  describe("softDelete()", () => {
    it("OR", async () => {
      const result = await em.softDelete(BclItem, {
        OR: [{ status: "open" }, { priority: { gte: 9 } }],
      });
      expect(result.affected).toBe(3);
      expect(await liveIds()).toEqual([3, 5]);
      expect(await allIds()).toEqual([1, 2, 3, 4, 5]);
    });

    it("NOT", async () => {
      const result = await em.softDelete(BclItem, { NOT: { tag: null } });
      expect(result.affected).toBe(3);
      expect(await liveIds()).toEqual([2, 5]);
    });

    it("nested: AND of an OR and a plain column", async () => {
      const result = await em.softDelete(BclItem, {
        AND: [{ OR: [{ tag: "a" }, { tag: "b" }] }, { priority: { gt: 1 } }],
      });
      expect(result.affected).toBe(2);
      expect(await liveIds()).toEqual([1, 2, 5]);
    });

    it("typo inside NOT is reported as a criteria column", async () => {
      const error = await captureError(() =>
        em.softDelete(BclItem, { NOT: { statuz: "open" } } as never),
      );
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Unknown column "statuz" in "criteria" for entity "BclItem". Did you mean "status"?',
      );
      expect(await liveIds()).toEqual([1, 2, 3, 4, 5]);
    });

    it("a combinator that resolves to nothing still trips the table-wide guard", async () => {
      await expect(em.softDelete(BclItem, { AND: [] })).rejects.toThrow(
        DeleteWithoutConditionsError,
      );
      expect(await liveIds()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("restore()", () => {
    beforeEach(async () => {
      await em.softDelete(BclItem, { id: { gt: 0 } });
      expect(await liveIds()).toEqual([]);
    });

    it("OR", async () => {
      const result = await em.restore(BclItem, {
        OR: [{ status: "open" }, { status: "archived" }],
      });
      expect(result.affected).toBe(3);
      expect(await liveIds()).toEqual([1, 2, 4]);
    });

    it("AND", async () => {
      const result = await em.restore(BclItem, {
        AND: [{ status: "closed" }, { NOT: { tag: null } }],
      });
      expect(result.affected).toBe(1);
      expect(await liveIds()).toEqual([3]);
    });

    it("NOT", async () => {
      const result = await em.restore(BclItem, { NOT: { priority: { lt: 5 } } });
      expect(result.affected).toBe(3);
      expect(await liveIds()).toEqual([2, 4, 5]);
    });

    it("typo inside OR is reported as a criteria column", async () => {
      const error = await captureError(() =>
        em.restore(BclItem, { OR: [{ statu: "open" }] } as never),
      );
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Unknown column "statu" in "criteria" for entity "BclItem". Did you mean "status"?',
      );
      expect(await liveIds()).toEqual([]);
    });

    it("a combinator that resolves to nothing still trips the table-wide guard", async () => {
      await expect(em.restore(BclItem, { OR: [] })).rejects.toThrow(
        DeleteWithoutConditionsError,
      );
      expect(await liveIds()).toEqual([]);
    });
  });
});
