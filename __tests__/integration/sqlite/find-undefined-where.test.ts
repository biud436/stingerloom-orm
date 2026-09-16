/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `undefined` values in where / criteria (V6-T0-6 fix 1).
 *
 * The resolver drops a top-level field whose value is `undefined`. On a
 * single-row read that turned `findOne({ where: { id: maybeId } })` into
 * `SELECT ... LIMIT 1` with no WHERE — an arbitrary row — and `exists()`
 * into "the table is not empty". PK lookups did the same, operator operands
 * produced `= NULL`, a raw TypeError or (for `isNull`) an inverted
 * `IS NOT NULL`, and empty OR branches crashed inside `join([])`.
 *
 * Pinned here against real SQL:
 *  - vacuous where (names fields, every value undefined) throws on the
 *    single-row reads and exists(); list reads and aggregates keep skipping;
 *  - partial undefined keeps being skipped everywhere (documented rule);
 *  - findByPK / findByPKs / findByPKsMap reject an undefined key;
 *  - undefined operator operands, IN elements and empty OR branches throw
 *    InvalidQueryError; `{ OR | AND | NOT: undefined }` is an absent key;
 *  - criteria writes reject empty criteria before any event or cascade read;
 *  - SelectQueryBuilder's three-argument where with an undefined value throws;
 *  - BaseRepository.remove() deletes by primary key only.
 */

import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { TransactionSessionManager } from "../../../src/dialects/TransactionSessionManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";
import { DeleteWithoutConditionsError } from "../../../src/errors/DeleteWithoutConditionsError";

@Entity({ name: "fuw_post" })
class FuwPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  title!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  status!: string | null;

  @Column({ type: "int" })
  score!: number;
}

@Entity({ name: "fuw_member" })
class FuwMember {
  @PrimaryColumn({ type: "varchar", length: 10 })
  tenantKey!: string;

  @PrimaryColumn({ type: "int" })
  userId!: number;

  @Column({ type: "varchar", length: 20 })
  label!: string;
}

/**
 * Same composite key, but the columns are named apart from the properties.
 * The where resolver falls back to the raw key, so both spellings reach the
 * right column and the PK guard has to accept both.
 */
@Entity({ name: "fuw_named_member" })
class FuwNamedMember {
  @PrimaryColumn({ type: "varchar", length: 10, name: "tenant_key" })
  tenantKey!: string;

  @PrimaryColumn({ type: "int", name: "user_id" })
  userId!: number;

  @Column({ type: "varchar", length: 20 })
  label!: string;
}

@Entity({ name: "fuw_parent" })
class FuwParent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 20 })
  name!: string;

  @OneToMany(() => FuwChild, { mappedBy: "parent", cascade: true })
  children!: FuwChild[];
}

@Entity({ name: "fuw_child" })
class FuwChild {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 20 })
  label!: string;

  @Column({ type: "int", nullable: true })
  parentId!: number | null;

  @ManyToOne(() => FuwParent, (p: FuwParent) => p.children, {
    joinColumn: "parentId",
  })
  parent!: FuwParent;
}

@Entity({ name: "fuw_soft" })
class FuwSoft {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 20 })
  name!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}

/** SQL text of a TransactionSessionManager.query spy call. */
function sqlOf(call: unknown[]): string {
  const a = call[0] as any;
  if (typeof a === "string") return a;
  return a?.sql ?? a?.text ?? String(a);
}

/**
 * Awaits a promise that must reject and hands back the error. The resolved
 * value goes into the failure message, so a run against unfixed code records
 * the wrong row it read instead of only "it did not throw".
 */
async function capture(p: Promise<unknown>): Promise<any> {
  let resolved: unknown;
  try {
    resolved = await p;
  } catch (err) {
    return err;
  }
  throw new Error(
    `expected the call to reject, but it resolved with ${JSON.stringify(resolved)}`,
  );
}

describe("[Integration] SQLite: undefined values in where", () => {
  let em: EntityManager;
  const u = undefined as any;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [FuwPost, FuwMember, FuwNamedMember, FuwParent, FuwChild, FuwSoft],
    });
    em.extend(bufferPlugin());
  });

  afterAll(async () => {
    await (em as unknown as { propagateShutdown?: () => Promise<void> }).propagateShutdown?.();
  });

  beforeEach(async () => {
    for (const t of [
      "fuw_post",
      "fuw_member",
      "fuw_named_member",
      "fuw_child",
      "fuw_parent",
      "fuw_soft",
    ]) {
      await em.query(`DELETE FROM "${t}"`);
    }
    await em.query(
      `INSERT INTO "fuw_post" ("id", "title", "status", "score") VALUES (1, 'a', 'open', 1), (2, 'b', 'closed', 2), (3, 'c', 'open', 3)`,
    );
    await em.query(
      `INSERT INTO "fuw_member" ("tenantKey", "userId", "label") VALUES ('t1', 1, 'x'), ('t1', 2, 'y'), ('t2', 1, 'z')`,
    );
    await em.query(
      `INSERT INTO "fuw_named_member" ("tenant_key", "user_id", "label") VALUES ('t1', 1, 'x'), ('t1', 2, 'y'), ('t2', 1, 'z')`,
    );
    await em.query(`INSERT INTO "fuw_parent" ("id", "name") VALUES (1, 'p1'), (2, 'p2')`);
    await em.query(
      `INSERT INTO "fuw_child" ("id", "label", "parentId") VALUES (1, 'c1', 1), (2, 'c2', 2)`,
    );
    await em.query(
      `INSERT INTO "fuw_soft" ("id", "name", "deletedAt") VALUES (1, 's1', NULL), (2, 's2', '2026-01-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const ids = (rows: any[]) => rows.map((r) => r.id).sort();

  // ── 1. single-row reads ────────────────────────────────────────────────

  describe("vacuous where on single-row reads", () => {
    it.each([
      ["findOne", () => em.findOne(FuwPost, { where: { id: u } })],
      ["findOneBy", () => em.findOneBy(FuwPost, { id: u })],
      ["findOneOrFail", () => em.findOneOrFail(FuwPost, { where: { id: u } })],
      ["findOneByOrFail", () => em.findOneByOrFail(FuwPost, { id: u })],
    ])("%s({ id: undefined }) rejects instead of reading row 1", async (method, call) => {
      const err = await capture(call());
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain(`${method.replace(/OrFail$/, "")}()`);
      expect(err.message).toContain('"FuwPost"');
      expect(err.message).toContain("(id)");
      expect(err.suggestion).toContain("null");
    });

    it("names every undefined path, including combinator and NOT leaves", async () => {
      const err = await capture(
        em.findOne(FuwPost, {
          where: { title: u, OR: [{ status: u }], NOT: { score: u } } as any,
        }),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("title, OR[0].status, NOT.score");
    });

    it("array-form where whose every leaf is undefined rejects", async () => {
      const err = await capture(em.findOneBy(FuwPost, [{ id: u }, { title: u }]));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("[0].id, [1].title");
    });
  });

  // ── 2 / 3. primary-key lookups ─────────────────────────────────────────

  describe("primary-key lookups", () => {
    it("findByPK(Post, undefined) rejects", async () => {
      const err = await capture(em.findByPK(FuwPost, undefined));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain('findByPK() received undefined as the primary key of "FuwPost"');
    });

    it("findByPK(Post, null) still reads IS NULL and returns null", async () => {
      await expect(em.findByPK(FuwPost, null)).resolves.toBeNull();
    });

    it("composite findByPK(Member, undefined) rejects", async () => {
      const err = await capture(em.findByPK(FuwMember, undefined));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("tenantKey, userId");
    });

    it("composite findByPK with a missing PK prop rejects and names it", async () => {
      const err = await capture(em.findByPK(FuwMember, { tenantKey: "t1", userId: u }));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("userId");
      expect(err.message).not.toContain("tenantKey,");
    });

    it("composite findByPK with every PK prop still finds the row", async () => {
      const row = await em.findByPK(FuwMember, { tenantKey: "t1", userId: 2 });
      expect(row?.label).toBe("y");
    });

    it("findByPKs(Post, [1, undefined]) rejects instead of returning [1]", async () => {
      const err = await capture(em.findByPKs(FuwPost, [1, undefined]));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("index 1");
    });

    it("composite findByPKs with a partial element rejects instead of broadening", async () => {
      const err = await capture(
        em.findByPKs(FuwMember, [{ tenantKey: "t1", userId: u }]),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("userId");
    });

    it("composite findByPKs with an undefined element rejects instead of a TypeError", async () => {
      const err = await capture(em.findByPKs(FuwMember, [undefined]));
      expect(err).toBeInstanceOf(InvalidQueryError);
    });

    it("findByPKsMap(Post, [1, undefined]) rejects", async () => {
      const err = await capture(em.findByPKsMap(FuwPost, [1, undefined]));
      expect(err).toBeInstanceOf(InvalidQueryError);
    });

    it("composite keys spelled with DB column names keep working", async () => {
      const row = await em.findByPK(FuwNamedMember, {
        tenant_key: "t1",
        user_id: 1,
      } as any);
      expect(row?.label).toBe("x");

      const rows = await em.findByPKs(FuwNamedMember, [
        { tenant_key: "t1", user_id: 2 } as any,
        { tenantKey: "t2", userId: 1 } as any,
      ]);
      expect(rows.map((m) => m.label).sort()).toEqual(["y", "z"]);
    });

    it("a DB-column-name key that is undefined is still rejected", async () => {
      const err = await capture(
        em.findByPK(FuwNamedMember, { tenant_key: "t1", user_id: u } as any),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("userId");
    });

    it("findByPKs with complete keys is unchanged", async () => {
      expect(ids(await em.findByPKs(FuwPost, [1, 3]))).toEqual([1, 3]);
      const members = await em.findByPKs(FuwMember, [
        { tenantKey: "t1", userId: 1 },
        { tenantKey: "t2", userId: 1 },
      ]);
      expect(members.map((m) => m.label).sort()).toEqual(["x", "z"]);
    });
  });

  // ── 4. exists ──────────────────────────────────────────────────────────

  it("exists(Post, { title: undefined }) rejects instead of answering true", async () => {
    const err = await capture(em.exists(FuwPost, { title: u }));
    expect(err).toBeInstanceOf(InvalidQueryError);
    expect(err.message).toContain("exists()");
  });

  // ── 5. repository and WriteBuffer entry points ─────────────────────────

  describe("repository and WriteBuffer", () => {
    it("repository findOne({ where: { id: undefined } }) rejects", async () => {
      const repo = em.getRepository(FuwPost);
      const err = await capture(repo.findOne({ where: { id: u } }));
      expect(err).toBeInstanceOf(InvalidQueryError);
    });

    it("buffer findOne with an undefined PK rejects instead of tracking row 1", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      const err = await capture(buf.findOne(FuwPost, { where: { id: u } }));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(buf.tracked()).toHaveLength(0);
    });

    it("buffer refresh() of an instance whose PK was cleared rejects instead of overwriting it", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      const post = (await buf.findOne(FuwPost, { where: { id: 3 } })) as any;
      expect(post.title).toBe("c");
      post.id = undefined;

      const err = await capture(buf.refresh(post));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(post.title).toBe("c");
    });
  });

  // ── 6. unchanged contracts ─────────────────────────────────────────────

  describe("unchanged: list reads, aggregates and partial undefined", () => {
    it("partial undefined is skipped on findOne", async () => {
      const row = await em.findOne(FuwPost, { where: { id: u, status: "closed" } });
      expect(row?.id).toBe(2);
    });

    it("find with an all-undefined where still reads every row", async () => {
      expect(ids(await em.find(FuwPost, { where: { id: u } }))).toEqual([1, 2, 3]);
    });

    it("count with an all-undefined where still counts every row", async () => {
      await expect(em.count(FuwPost, { id: u })).resolves.toBe(3);
    });

    it("findOne without a where or with an empty where still reads a row", async () => {
      expect((await em.findOne(FuwPost, {}))?.id).toBeDefined();
      expect((await em.findOne(FuwPost, { where: {} }))?.id).toBeDefined();
      expect((await em.findOne(FuwPost, { where: { OR: [] } as any }))?.id).toBeDefined();
    });

    it("exists without a where is still legal", async () => {
      await expect(em.exists(FuwPost)).resolves.toBe(true);
      await expect(em.exists(FuwPost, undefined)).resolves.toBe(true);
    });

    it("an undefined leaf next to a NOT filter keeps the NOT filter", async () => {
      const rows = await em.find(FuwPost, { where: { id: u, NOT: { title: "a" } } as any });
      expect(ids(rows)).toEqual([2, 3]);
      const one = await em.findOne(FuwPost, {
        where: { id: u, NOT: { title: "a" } } as any,
        orderBy: { id: "ASC" },
      });
      expect(one?.id).toBe(2);
    });
  });

  // ── 7. operator operands ───────────────────────────────────────────────

  describe("undefined operator operands", () => {
    it.each([
      ["eq", { id: { eq: u } }],
      ["ne", { id: { ne: u } }],
      ["gt", { id: { gt: u } }],
      ["in", { id: { in: u } }],
      ["notIn", { id: { notIn: u } }],
      ["in element", { id: { in: [1, u] } }],
      ["top-level array element", { id: [1, u] }],
      ["between bound", { id: { between: [1, u] } }],
      ["between", { id: { between: u } }],
      ["contains", { title: { contains: u } }],
      ["startsWith", { title: { startsWith: u } }],
      ["like", { title: { like: u } }],
      ["not", { title: { not: u } }],
      ["isNull", { status: { isNull: u } }],
    ])("%s: rejects with InvalidQueryError", async (_label, where) => {
      const err = await capture(em.find(FuwPost, { where: where as any }));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("undefined");
    });

    it("isNull: undefined no longer inverts to IS NOT NULL on a write", async () => {
      const err = await capture(em.delete(FuwPost, { status: { isNull: u } } as any));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(await em.count(FuwPost)).toBe(3);
    });

    it("defined operands are unchanged", async () => {
      expect(ids(await em.find(FuwPost, { where: { id: { in: [1, 2] } } }))).toEqual([1, 2]);
      expect(ids(await em.find(FuwPost, { where: { status: { isNull: false } } }))).toEqual([1, 2, 3]);
      expect(ids(await em.find(FuwPost, { where: { id: { between: [2, 3] } } }))).toEqual([2, 3]);
    });
  });

  // ── 8. combinators ─────────────────────────────────────────────────────

  describe("combinator branches", () => {
    it.each([
      ["array form with an all-undefined element", [{ id: u }, { id: 2 }]],
      ["OR with an all-undefined branch", { OR: [{ id: u }] }],
      ["OR with an empty branch", { OR: [{}, { id: 2 }] }],
    ])("%s rejects with InvalidQueryError", async (_label, where) => {
      const err = await capture(em.find(FuwPost, { where: where as any }));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("no condition");
    });

    it("{ OR: undefined } and { NOT: undefined } are absent keys", async () => {
      expect(ids(await em.find(FuwPost, { where: { OR: u } as any }))).toEqual([1, 2, 3]);
      expect(ids(await em.find(FuwPost, { where: { NOT: u } as any }))).toEqual([1, 2, 3]);
      expect(ids(await em.find(FuwPost, { where: { AND: u, title: "b" } as any }))).toEqual([2]);
    });

    it("an empty AND branch is the identity", async () => {
      expect(ids(await em.find(FuwPost, { where: { AND: [{}, { id: 2 }] } as any }))).toEqual([2]);
    });

    it("OR with defined branches is unchanged", async () => {
      expect(ids(await em.find(FuwPost, { where: { OR: [{ id: 1 }, { title: "c" }] } }))).toEqual([1, 3]);
    });
  });

  // ── 9 / 10 / 11. criteria writes ───────────────────────────────────────

  describe("criteria writes", () => {
    it("delete({ id: undefined }) with an O2M cascade throws before any event or cascade read", async () => {
      const spy = jest.spyOn(TransactionSessionManager.prototype, "query");
      const beforeDelete = jest.fn();
      em.on("beforeDelete", beforeDelete);
      try {
        const err = await capture(em.delete(FuwParent, { id: u }));
        expect(err).toBeInstanceOf(DeleteWithoutConditionsError);
      } finally {
        em.off("beforeDelete", beforeDelete);
      }

      const statements = spy.mock.calls.map(sqlOf);
      expect(statements.filter((s) => /FROM\s+"fuw_parent"/i.test(s))).toEqual([]);
      expect(statements.filter((s) => /DELETE\s+FROM\s+"fuw_child"/i.test(s))).toEqual([]);
      expect(beforeDelete).not.toHaveBeenCalled();
      expect(await em.count(FuwChild)).toBe(2);
    });

    it("softDelete / restore with all-undefined criteria throw before their before* events", async () => {
      const beforeSoftDelete = jest.fn();
      const beforeRestore = jest.fn();
      em.on("beforeSoftDelete", beforeSoftDelete);
      em.on("beforeRestore", beforeRestore);
      try {
        expect(await capture(em.softDelete(FuwSoft, { id: u }))).toBeInstanceOf(
          DeleteWithoutConditionsError,
        );
        expect(await capture(em.restore(FuwSoft, { name: u }))).toBeInstanceOf(
          DeleteWithoutConditionsError,
        );
      } finally {
        em.off("beforeSoftDelete", beforeSoftDelete);
        em.off("beforeRestore", beforeRestore);
      }
      expect(beforeSoftDelete).not.toHaveBeenCalled();
      expect(beforeRestore).not.toHaveBeenCalled();
    });

    it("updateMany with an empty SET and an all-undefined where throws instead of { affected: 0 }", async () => {
      const err = await capture(
        em.updateMany(FuwPost, { title: u }, { where: { id: u } }),
      );
      expect(err).toBeInstanceOf(DeleteWithoutConditionsError);
    });

    it("updateMany with an empty SET and a real where still returns { affected: 0 }", async () => {
      await expect(
        em.updateMany(FuwPost, { title: u }, { where: { id: 1 } }),
      ).resolves.toEqual({ affected: 0 });
    });

    it("delete({ OR: [{ id: undefined }] }) throws InvalidQueryError and deletes nothing", async () => {
      const err = await capture(em.delete(FuwPost, { OR: [{ id: u }] } as any));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(await em.count(FuwPost)).toBe(3);
    });

    it("partial undefined criteria are still skipped on delete", async () => {
      const result = await em.delete(FuwPost, { id: 2, title: u });
      expect(result.affected).toBe(1);
    });
  });

  // ── 12. SelectQueryBuilder three-argument where ────────────────────────

  describe("SelectQueryBuilder where(col, op, undefined)", () => {
    it.each(["where", "andWhere", "orWhere"] as const)(
      "%s('id', '>', undefined) throws instead of comparing id to '>'",
      (method) => {
        const qb = em.createQueryBuilder(FuwPost, "p").where("id", 1);
        let err: any;
        try {
          (qb as any)[method]("id", ">", undefined);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(InvalidQueryError);
        expect(err.message).toContain(`${method}()`);
        expect(err.message).toContain('">"');
      },
    );

    it("where group where('id', '>', undefined) throws too", () => {
      let err: any;
      try {
        em.createQueryBuilder(FuwPost, "p").andWhereGroup((g) => {
          g.where("id", ">", undefined);
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InvalidQueryError);
    });

    it("a string the builder does not resolve as an operator throws too", () => {
      // `where("title", "NOT BETWEEN", 1)` is rejected as an unsupported
      // operator, so the same call with an undefined value must not quietly
      // demote to `"title" = 'NOT BETWEEN'` and read zero rows.
      let err: any;
      try {
        em.createQueryBuilder(FuwPost, "p").where("title", "NOT BETWEEN" as any, undefined);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain('"NOT BETWEEN"');
      expect(err.suggestion).toContain("drop the third argument");
    });

    it("IS NULL / IS NOT NULL with an explicit undefined third argument read as the operator", async () => {
      await em.query(`UPDATE "fuw_post" SET "status" = NULL WHERE "id" = 3`);
      const nulls = await em
        .createQueryBuilder(FuwPost, "p")
        .where("status", "IS NULL", undefined)
        .getMany();
      expect(ids(nulls)).toEqual([3]);

      const notNulls = await em
        .createQueryBuilder(FuwPost, "p")
        .where("status", "IS NOT NULL", undefined)
        .getMany();
      expect(ids(notNulls)).toEqual([1, 2]);
    });

    it("a non-string second argument keeps the two-argument meaning", async () => {
      // The escape hatch for wrappers that always forward three arguments: a
      // second argument that cannot be an operator builds the SQL the
      // two-argument call builds.
      expect(
        ids(await em.createQueryBuilder(FuwPost, "p").where("score", 2 as any, undefined).getMany()),
      ).toEqual([2]);
      expect(
        ids(await em.createQueryBuilder(FuwPost, "p").where("id", [1, 3] as any, undefined).getMany()),
      ).toEqual([1, 3]);
    });

    it("two-argument and defined three-argument forms are unchanged", async () => {
      expect(ids(await em.createQueryBuilder(FuwPost, "p").where("id", ">", 1).getMany())).toEqual([2, 3]);
      expect(ids(await em.createQueryBuilder(FuwPost, "p").where("title", "b").getMany())).toEqual([2]);
    });
  });

  // ── 13. BaseRepository.remove ──────────────────────────────────────────

  describe("BaseRepository.remove()", () => {
    it("remove({ id: undefined, title: 'c' }) throws instead of deleting by title", async () => {
      const repo = em.getRepository(FuwPost);
      const err = await capture(repo.remove({ id: u, title: "c" } as any));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain('"id"');
      expect(await em.count(FuwPost)).toBe(3);
    });

    it("remove() of a stale instance deletes it by primary key only", async () => {
      const repo = em.getRepository(FuwPost);
      const result = await repo.remove({ id: 2, title: "stale", status: "gone", score: 99 } as any);
      expect(result.affected).toBe(1);
      expect(ids(await em.find(FuwPost))).toEqual([1, 3]);
    });

    it("remove() on a composite key uses every PK column", async () => {
      const repo = em.getRepository(FuwMember);
      const result = await repo.remove({ tenantKey: "t1", userId: 1, label: "stale" } as any);
      expect(result.affected).toBe(1);
      expect(await em.count(FuwMember)).toBe(2);
    });
  });
});
