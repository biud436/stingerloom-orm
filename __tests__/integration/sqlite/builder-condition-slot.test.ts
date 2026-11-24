/**
 * What a builder does with a condition-slot argument that is not a condition,
 * on a live SQLite EntityManager.
 *
 * A condition slot takes a sql`` fragment or a QueryDSL condition. Before the
 * check, anything else went into the statement as if it were a fragment:
 *
 * - `createQueryBuilder().where(5)` and `.where(new Date())` returned every
 *   row (no filter at all);
 * - `createQueryBuilder().where(undefined)` returned no rows;
 * - `createUpdateBuilder().where("id = 1")` reported `affected: 0`;
 * - `createUpdateBuilder().where({ id: 1 })` died in the driver with
 *   `RangeError: Too few parameter values were provided`;
 * - `having(undefined)` and a where-group `where(null)` threw bare TypeErrors.
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import { Entity, Column, PrimaryColumn, sql, qAlias } from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "bcs_items" })
class Item {
  @PrimaryColumn({ type: "varchar", length: 20 })
  code!: string;

  @Column({ type: "int" })
  amount!: number;
}

function capture(fn: () => unknown): InvalidQueryError {
  try {
    fn();
  } catch (e) {
    return e as InvalidQueryError;
  }
  throw new Error("expected the call to throw");
}

describe("[Integration] SQLite In-Memory: builder condition slots", () => {
  let em: EntityManager;
  // The slots are typed; the calls below are what an untyped caller can write.
  const anyEm = (): any => em;

  const amounts = async () =>
    (await em.find(Item, { orderBy: { code: "ASC" } })).map((r) => r.amount);

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [Item] });
  });

  beforeEach(async () => {
    await em.deleteMany(Item, ["a", "b"]);
    await em.save(Item, { code: "a", amount: 1 });
    await em.save(Item, { code: "b", amount: 2 });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  describe("createUpdateBuilder()", () => {
    const cases: Array<[string, unknown, string]> = [
      ["a find-style object", { code: "a" }, "a plain object"],
      ["a string of SQL", "code = 'a'", `the string "code = 'a'"`],
      ["undefined", undefined, "undefined"],
      ["null", null, "null"],
      ["a number", 1, "the number 1"],
    ];

    it.each(cases)("where() refuses %s and writes nothing", async (_label, value, described) => {
      const builder = anyEm().createUpdateBuilder(Item).set({ amount: 99 });

      const error = capture(() => builder.where(value));

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain("UpdateQueryBuilder.where()");
      expect(error.message).toContain(described);
      expect(await amounts()).toEqual([1, 2]);
    });

    it("andWhere() and orWhere() name themselves", () => {
      const builder = anyEm().createUpdateBuilder(Item).set({ amount: 99 });

      expect(capture(() => builder.andWhere(undefined)).message).toContain(
        "UpdateQueryBuilder.andWhere()",
      );
      expect(capture(() => builder.orWhere({ code: "a" })).message).toContain(
        "UpdateQueryBuilder.orWhere()",
      );
      builder.where(sql`1 = 1`);
      expect(capture(() => builder.orWhere({ code: "a" })).message).toContain(
        "UpdateQueryBuilder.orWhere()",
      );
    });

    it("still takes a sql fragment and a QueryDSL condition", async () => {
      const i = qAlias(Item, "i");

      await em.createUpdateBuilder(Item).set({ amount: 10 }).where(sql`code = ${"a"}`).execute();
      await em.createUpdateBuilder(Item).set({ amount: 20 }).where(i.code.eq("b")).execute();

      expect(await amounts()).toEqual([10, 20]);
    });
  });

  describe("createInsertBuilder()", () => {
    it("doUpdateWhere() refuses a find-style object before any statement runs", async () => {
      const builder = anyEm()
        .createInsertBuilder(Item)
        .values({ code: "a", amount: 50 })
        .onConflict(["code"])
        .doUpdate(["amount"]);

      const error = capture(() => builder.doUpdateWhere({ amount: { lt: 5 } }));

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain("InsertQueryBuilder.doUpdateWhere()");
      expect(error.message).toContain("a plain object");
      expect(await amounts()).toEqual([1, 2]);
    });

    it("onConflict() refuses a where that is not a condition", () => {
      const builder = anyEm().createInsertBuilder(Item).values({ code: "a", amount: 50 });

      const error = capture(() => builder.onConflict(["code"], { where: "amount > 0" }));

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain("InsertQueryBuilder.onConflict() where");
    });

    it("doUpdateWhere() still takes a QueryDSL condition", async () => {
      const i = qAlias(Item, "i");

      await em
        .createInsertBuilder(Item)
        .values({ code: "a", amount: 50 })
        .onConflict(["code"])
        .doUpdate(["amount"])
        .doUpdateWhere(i.amount.gt(100))
        .execute();
      await em
        .createInsertBuilder(Item)
        .values({ code: "b", amount: 60 })
        .onConflict(["code"])
        .doUpdate(["amount"])
        .doUpdateWhere(i.amount.lt(100))
        .execute();

      expect(await amounts()).toEqual([1, 60]);
    });
  });

  describe("createQueryBuilder()", () => {
    const values: Array<[string, unknown, string]> = [
      ["undefined", undefined, "undefined"],
      ["a number", 5, "the number 5"],
      ["a Date", new Date(0), "a Date instance"],
      ["a boolean", true, "the boolean true"],
      ["an unawaited promise", Promise.resolve({ code: "a" }), "a Promise instance"],
    ];

    it.each(values)("where() refuses %s", (_label, value, described) => {
      const error = capture(() => anyEm().createQueryBuilder(Item, "i").where(value));

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain("where()");
      expect(error.message).toContain(described);
    });

    it("andWhere() and orWhere() refuse undefined", () => {
      expect(
        capture(() => anyEm().createQueryBuilder(Item, "i").andWhere(undefined)),
      ).toBeInstanceOf(InvalidQueryError);
      expect(
        capture(() => anyEm().createQueryBuilder(Item, "i").orWhere(undefined)),
      ).toBeInstanceOf(InvalidQueryError);
    });

    it("having() refuses a find-style object and undefined", () => {
      const object = capture(() =>
        anyEm().createQueryBuilder(Item, "i").groupBy(["i.code"]).having({ amount: 1 }),
      );
      const missing = capture(() =>
        anyEm().createQueryBuilder(Item, "i").groupBy(["i.code"]).having(undefined),
      );

      expect(object).toBeInstanceOf(InvalidQueryError);
      expect(object.message).toContain("SelectQueryBuilder.having()");
      expect(object.message).toContain("a plain object");
      expect(missing).toBeInstanceOf(InvalidQueryError);
    });

    it("a where group refuses an object, null and undefined", () => {
      for (const value of [{ code: "a" }, null, undefined]) {
        const error = capture(() =>
          anyEm()
            .createQueryBuilder(Item, "i")
            .andWhereGroup((g: any) => g.where(value)),
        );

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect(error.message).toContain("WhereGroupBuilder.where()");
      }
    });

    it("still takes a where object, a sql fragment, a condition and a group", async () => {
      const i = qAlias(Item, "i");
      const codes = async (qb: any) => (await qb.getMany()).map((r: Item) => r.code);

      expect(await codes(em.createQueryBuilder(Item, "i").where({ code: "a" }))).toEqual(["a"]);
      expect(await codes(em.createQueryBuilder(Item, "i").where(sql`amount = ${2}`))).toEqual(["b"]);
      expect(await codes(em.createQueryBuilder(Item, "i").where(i.amount.gte(2)))).toEqual(["b"]);
      expect(
        await codes(
          em
            .createQueryBuilder(Item, "i")
            .andWhereGroup((g) => g.where(sql`amount >= ${1}`).where(i.amount.lte(2)))
            .addOrderBy("i.code", "ASC"),
        ),
      ).toEqual(["a", "b"]);
    });
  });
});
