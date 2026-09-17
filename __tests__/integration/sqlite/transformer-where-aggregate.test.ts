/**
 * `@Column({ transformer })` on the read side (V6-T0-3).
 *
 * A column written through `transformer.to` stores another value than the
 * one the caller holds. Where operands were bound as written, so an equality
 * on the domain value matched nothing and an inequality compared against the
 * stored scale and was true by accident. Aggregates came back in the stored
 * scale while the hydrated property did not. These cases run real SQL.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import sql from "../../../src/utils/sqlTag";

@Entity({ name: "twa_docs" })
class TwaDoc {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: "varchar",
    length: 20,
    transformer: {
      to: (v: string) => v.toUpperCase(),
      from: (v: string) => v.toLowerCase(),
    },
  })
  code!: string;

  @Column({
    type: "int",
    transformer: {
      to: (v: number) => Math.round(v * 100),
      from: (v: number) => v / 100,
    },
  })
  price!: number;

  @Column({ type: "int" })
  plain!: number;
}

describe("[Integration] SQLite: transformer on where operands and aggregates", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [TwaDoc] });
  });

  beforeEach(async () => {
    await em.query("DELETE FROM twa_docs");
    await em.save(TwaDoc, { code: "abc", price: 12.5, plain: 1 });
    await em.save(TwaDoc, { code: "def", price: 5, plain: 2 });
    await em.save(TwaDoc, { code: "ghi", price: 0.5, plain: 3 });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  const codes = (rows: TwaDoc[]) => rows.map((r) => r.code).sort();

  it("stores the transformed value", async () => {
    const rows = (await em.query(
      "SELECT code, price FROM twa_docs ORDER BY id",
    )) as Array<{ code: string; price: number }>;
    expect(rows[0]).toEqual({ code: "ABC", price: 1250 });
  });

  describe("equality", () => {
    it("findOne / find / findOneBy-style where", async () => {
      expect((await em.findOne(TwaDoc, { where: { code: "abc" } }))?.price).toBe(12.5);
      expect(codes(await em.find(TwaDoc, { where: { price: 5 } }))).toEqual(["def"]);
      expect(codes(await em.find(TwaDoc, { where: { code: { eq: "ghi" } } }))).toEqual(["ghi"]);
    });

    it("ne / not", async () => {
      expect(codes(await em.find(TwaDoc, { where: { code: { ne: "abc" } } }))).toEqual(["def", "ghi"]);
      expect(codes(await em.find(TwaDoc, { where: { code: { not: "abc" } } }))).toEqual(["def", "ghi"]);
    });

    it("count / exists", async () => {
      expect(await em.count(TwaDoc, { code: "abc" })).toBe(1);
      expect(await em.exists(TwaDoc, { code: "abc" })).toBe(true);
      expect(await em.exists(TwaDoc, { code: "zzz" })).toBe(false);
    });

    it("array shorthand and in / notIn, per element", async () => {
      expect(codes(await em.find(TwaDoc, { where: { code: ["abc", "def"] as any } }))).toEqual(["abc", "def"]);
      expect(codes(await em.find(TwaDoc, { where: { code: { in: ["abc"] } } }))).toEqual(["abc"]);
      expect(codes(await em.find(TwaDoc, { where: { price: { notIn: [5, 0.5] } } }))).toEqual(["abc"]);
    });

    it("inside OR / AND / NOT", async () => {
      expect(
        codes(await em.find(TwaDoc, { where: { OR: [{ code: "abc" }, { price: 0.5 }] } })),
      ).toEqual(["abc", "ghi"]);
      expect(codes(await em.find(TwaDoc, { where: { NOT: { code: "abc" } } }))).toEqual(["def", "ghi"]);
    });
  });

  describe("ranges compare in the domain scale", () => {
    it("gt / gte / lt / lte", async () => {
      // Stored 1250 / 500 / 50: a raw `> 12` matched all three.
      expect(codes(await em.find(TwaDoc, { where: { price: { gt: 12 } } }))).toEqual(["abc"]);
      expect(codes(await em.find(TwaDoc, { where: { price: { gte: 5 } } }))).toEqual(["abc", "def"]);
      expect(codes(await em.find(TwaDoc, { where: { price: { lt: 5 } } }))).toEqual(["ghi"]);
      expect(codes(await em.find(TwaDoc, { where: { price: { lte: 5 } } }))).toEqual(["def", "ghi"]);
    });

    it("between", async () => {
      expect(codes(await em.find(TwaDoc, { where: { price: { between: [1, 13] } } }))).toEqual(["abc", "def"]);
    });
  });

  describe("left as written", () => {
    it("pattern operators use the stored representation", async () => {
      expect(codes(await em.find(TwaDoc, { where: { code: { like: "AB%" } } }))).toEqual(["abc"]);
      expect(codes(await em.find(TwaDoc, { where: { code: { startsWith: "AB" } } }))).toEqual(["abc"]);
      expect(codes(await em.find(TwaDoc, { where: { code: { contains: "E" } } }))).toEqual(["def"]);
    });

    it("null and raw sql operands", async () => {
      expect(await em.find(TwaDoc, { where: { code: null as any } })).toEqual([]);
      expect(
        codes(await em.find(TwaDoc, { where: { code: sql`"code" = ${"ABC"}` as any } })),
      ).toEqual(["abc"]);
    });

    it("columns without a transformer", async () => {
      expect(codes(await em.find(TwaDoc, { where: { plain: { gt: 1 } } }))).toEqual(["def", "ghi"]);
    });
  });

  describe("criteria writes", () => {
    it("updateMany", async () => {
      const result = await em.updateMany(TwaDoc, { plain: 9 }, { where: { code: "abc" } });
      expect(result.affected).toBe(1);
      expect((await em.findOne(TwaDoc, { where: { code: "abc" } }))?.plain).toBe(9);
    });

    it("delete", async () => {
      const result = await em.delete(TwaDoc, { price: { gt: 12 } });
      expect(result.affected).toBe(1);
      expect(codes(await em.find(TwaDoc, {}))).toEqual(["def", "ghi"]);
    });
  });

  it("findWithCursor where", async () => {
    const page = await em.findWithCursor(TwaDoc, { take: 10, where: { price: { gt: 1 } } });
    expect(codes(page.data)).toEqual(["abc", "def"]);
  });

  describe("SelectQueryBuilder", () => {
    it("string column forms", async () => {
      const qb = () => em.createQueryBuilder(TwaDoc, "d");
      expect(codes(await qb().where("code", "abc").getMany())).toEqual(["abc"]);
      expect(codes(await qb().where("d.code", "=", "abc").getMany())).toEqual(["abc"]);
      expect(codes(await qb().where("d.price", ">", 12).getMany())).toEqual(["abc"]);
      expect(codes(await qb().where("price", "BETWEEN", [1, 13]).getMany())).toEqual(["abc", "def"]);
      expect(codes(await qb().where("code", "IN", ["abc", "ghi"]).getMany())).toEqual(["abc", "ghi"]);
      expect(codes(await qb().whereIn("code", ["def"]).getMany())).toEqual(["def"]);
      expect(codes(await qb().where("code", "LIKE", "AB%").getMany())).toEqual(["abc"]);
    });

    it("where object form", async () => {
      const rows = await em
        .createQueryBuilder(TwaDoc, "d")
        .where({ code: "abc", price: { gte: 12.5 } })
        .getMany();
      expect(codes(rows)).toEqual(["abc"]);
    });

    it("aggregates", async () => {
      const qb = em.createQueryBuilder(TwaDoc, "d");
      expect(await qb.getMax("price")).toBe(12.5);
      expect(await em.createQueryBuilder(TwaDoc, "d").getSum("price")).toBe(18);
    });
  });

  describe("aggregates return the domain scale", () => {
    it("sum / avg / min / max", async () => {
      expect(await em.sum(TwaDoc, "price")).toBe(18);
      expect(await em.avg(TwaDoc, "price")).toBe(6);
      expect(await em.min(TwaDoc, "price")).toBe(0.5);
      expect(await em.max(TwaDoc, "price")).toBe(12.5);
      expect(await em.max(TwaDoc, "price", { price: { lt: 12 } })).toBe(5);
    });

    it("count and untransformed columns are untouched", async () => {
      expect(await em.count(TwaDoc)).toBe(3);
      expect(await em.sum(TwaDoc, "plain")).toBe(6);
    });
  });
});
