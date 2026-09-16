/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: array and object property values are written intact, or
 * rejected with an error that names the column.
 *
 * Regressions (V6-T0-6):
 *
 *   - `@Column() tags!: string[]` inferred `text` from design:type `Array`,
 *     and the write paths bound the JS array as one value. better-sqlite3
 *     spreads an array over the positional parameters and reads a plain
 *     object as a named-parameter bag that fills no slot, so
 *     `save({ tags: ["a", "b"], meta: { k: 1 } })` stored `tags = "a"` and
 *     `meta = "b"` without an error; other lengths died with a bare
 *     `RangeError: Too many / Too few parameter values`.
 *   - `updateMany()`, `update()` and `createUpdateBuilder().set()` skipped the
 *     write transforms: a `json` column received the raw array (spread again)
 *     and `transformer.to` never ran.
 *   - `type: "array"` and `t.array()` had no serialization outside
 *     PostgreSQL, so they could not store a multi-element array on SQLite.
 *   - Raw `em.query("SELECT ?", [[1, 2]])` spread the array silently.
 */
import "reflect-metadata";
import sql from "sql-template-tag";
import {
  Column,
  COLUMN_TOKEN,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import { defineEntity, t } from "../../../src/schema";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

// ── Entities ────────────────────────────────────────────────────────────────

/** The original report: an array and an object property with no explicit type. */
@Entity({ name: "aoi_note" })
class AoiNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column() tags!: string[];
  @Column() meta!: Record<string, unknown>;
  @Column() note!: string;
}

/** Inferred array column, with a unique key for the upsert paths. */
@Entity({ name: "aoi_tagged" })
@UniqueIndex(["slug"])
class AoiTagged {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column() tags!: string[];
}

@Entity({ name: "aoi_owner" })
class AoiOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

/** Explicit json columns, a transformer column, a text column and an FK shadow key. */
@Entity({ name: "aoi_doc" })
class AoiDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "json" }) tags!: string[];
  @Column({ type: "json" }) meta!: Record<string, unknown>;
  @Column({
    type: "varchar",
    length: 120,
    transformer: {
      to: (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v),
    },
  })
  email!: string;
  @Column({ type: "text", nullable: true }) label!: string | null;

  @ManyToOne(() => AoiOwner, () => undefined)
  @RelationColumn({ name: "ownerId" })
  owner!: AoiOwner;

  ownerId?: number;
}

const comma = {
  to: (v: string[] | null | undefined) => (v == null ? v : v.join(",")),
  from: (v: string | null) => (v == null ? v : v.split(",")),
};

/** Array property with a write transformer and no type: a legitimate text column. */
@Entity({ name: "aoi_csv" })
class AoiCsv {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ transformer: comma }) tags!: string[];
}

/**
 * Array property with a read-only transform. It has no write side, so the ORM
 * still owns the stored shape and the column is inferred like any other array
 * property; the transform keeps owning what the property holds on read.
 */
@Entity({ name: "aoi_legacy" })
class AoiLegacy {
  @PrimaryGeneratedColumn() id!: number;
  @Column({
    transform: ((raw: unknown) =>
      typeof raw === "string" ? JSON.parse(raw) : raw) as any,
  })
  tags!: string[];
}

@Entity({ name: "aoi_arr" })
class AoiArr {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "array" }) labels!: string[];
}

const AoiDefArr = defineEntity("aoi_def_arr", {
  id: t.int().primary().generated(),
  labels: t.array<string>(),
});

/** A nested DTO instance (class-transformer `@Type(() => MetaDto)` shape). */
class MetaDto {
  k = 1;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function columnType(entity: { prototype: object }, prop: string): unknown {
  const columns: Array<{ propertyKey: string; options: { type?: unknown } }> =
    Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ?? [];
  return columns.find((c) => c.propertyKey === prop)?.options.type;
}

describe("[Integration] SQLite: array/object properties and non-scalar bind values", () => {
  let em: EntityManager;

  async function rawRows(table: string): Promise<any[]> {
    return em.query(`SELECT * FROM "${table}" ORDER BY "id"`);
  }

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [
        AoiNote,
        AoiTagged,
        AoiOwner,
        AoiDoc,
        AoiCsv,
        AoiLegacy,
        AoiArr,
        AoiDefArr,
      ],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    for (const table of [
      "aoi_note",
      "aoi_tagged",
      "aoi_doc",
      "aoi_owner",
      "aoi_csv",
      "aoi_legacy",
      "aoi_arr",
      "aoi_def_arr",
    ]) {
      await em.query(`DELETE FROM "${table}"`);
    }
  });

  // ── 1. The original report ────────────────────────────────────────────────

  describe("inference", () => {
    it("maps an array property to json and keeps an object property on text", () => {
      expect(columnType(AoiNote, "tags")).toBe("json");
      expect(columnType(AoiNote, "meta")).toBe("text");
    });

    it("keeps text for an array property that has a write transformer", () => {
      expect(columnType(AoiCsv, "tags")).toBe("text");
    });

    it("maps an array property with a read-only transform to json", () => {
      expect(columnType(AoiLegacy, "tags")).toBe("json");
    });
  });

  it("rejects an object bound to an inferred text column, naming it, and writes nothing", async () => {
    const err = await captureError(() =>
      em.save(AoiNote, {
        name: "n1",
        tags: ["a", "b"],
        meta: { k: 1 },
        note: "note1",
      }),
    );

    expect(err).toBeInstanceOf(InvalidQueryError);
    expect((err as Error).message).toContain("AoiNote.meta");
    expect((err as Error).message).toContain('"text" column');
    expect((err as Error).message).toContain("object");
    expect(await rawRows("aoi_note")).toHaveLength(0);
  });

  // ── 2. Inferred array column round-trips on every write path ──────────────

  describe("inferred array column round-trips", () => {
    const shapes: string[][] = [["a", "b"], [], ["solo"]];

    async function tagsOf(slug: string): Promise<unknown> {
      const row = await em.findOne(AoiTagged, { where: { slug } });
      return row?.tags;
    }

    it("save()", async () => {
      for (const [i, tags] of shapes.entries()) {
        await em.save(AoiTagged, { slug: `s${i}`, tags });
        expect(await tagsOf(`s${i}`)).toEqual(tags);
      }
      const raw = await rawRows("aoi_tagged");
      expect(raw.map((r) => r.tags)).toEqual(['["a","b"]', "[]", '["solo"]']);
    });

    it("insertMany()", async () => {
      await em.insertMany(
        AoiTagged,
        shapes.map((tags, i) => ({ slug: `m${i}`, tags })),
      );
      for (const [i, tags] of shapes.entries()) {
        expect(await tagsOf(`m${i}`)).toEqual(tags);
      }
    });

    it("upsert() on insert and on conflict", async () => {
      await em.upsert(AoiTagged, { slug: "u", tags: ["a", "b"] }, ["slug"]);
      expect(await tagsOf("u")).toEqual(["a", "b"]);
      await em.upsert(AoiTagged, { slug: "u", tags: ["solo"] }, ["slug"]);
      expect(await tagsOf("u")).toEqual(["solo"]);
      await em.upsert(AoiTagged, { slug: "u", tags: [] }, ["slug"]);
      expect(await tagsOf("u")).toEqual([]);
    });

    it("batchUpsert()", async () => {
      await em.batchUpsert(
        AoiTagged,
        shapes.map((tags, i) => ({ slug: `b${i}`, tags })),
        ["slug"],
      );
      for (const [i, tags] of shapes.entries()) {
        expect(await tagsOf(`b${i}`)).toEqual(tags);
      }
      await em.batchUpsert(AoiTagged, [{ slug: "b0", tags: ["x", "y", "z"] }], ["slug"]);
      expect(await tagsOf("b0")).toEqual(["x", "y", "z"]);
    });

    it("createInsertBuilder() values and a literal doUpdate", async () => {
      await em
        .createInsertBuilder(AoiTagged)
        .values({ slug: "ib", tags: ["a", "b"] })
        .execute();
      expect(await tagsOf("ib")).toEqual(["a", "b"]);

      await em
        .createInsertBuilder(AoiTagged)
        .values({ slug: "ib", tags: ["ignored"] })
        .onConflict(["slug"])
        .doUpdate({ tags: ["q1", "q2"] })
        .execute();
      expect(await tagsOf("ib")).toEqual(["q1", "q2"]);
    });

    it("updateMany() and update()", async () => {
      const row = await em.save(AoiTagged, { slug: "um", tags: ["seed"] });

      await em.updateMany(AoiTagged, { tags: ["m1", "m2"] }, { where: { id: row.id } });
      expect(await tagsOf("um")).toEqual(["m1", "m2"]);

      await em.update(AoiTagged, { id: row.id }, { tags: [] });
      expect(await tagsOf("um")).toEqual([]);

      await em.update(AoiTagged, { id: row.id }, { tags: ["solo"] });
      expect(await tagsOf("um")).toEqual(["solo"]);
    });

    it("createUpdateBuilder().set()", async () => {
      const row = await em.save(AoiTagged, { slug: "qb", tags: ["seed"] });

      await em
        .createUpdateBuilder(AoiTagged)
        .set({ tags: ["qb1", "qb2"] })
        .where(sql`"id" = ${row.id}`)
        .execute();
      expect(await tagsOf("qb")).toEqual(["qb1", "qb2"]);
    });
  });

  // ── 3/4. Explicit json and transformer.to on the criteria update paths ────

  describe("criteria updates apply write transforms", () => {
    async function seedDoc(): Promise<AoiDoc> {
      return em.save(AoiDoc, {
        tags: ["t"],
        meta: { seed: true },
        email: "SEED@X.COM",
      });
    }

    it("updateMany() stringifies json columns", async () => {
      const doc = await seedDoc();

      await em.updateMany(
        AoiDoc,
        { tags: ["m1", "m2"], meta: { m: 1 } },
        { where: { id: doc.id } },
      );

      const found = await em.findOne(AoiDoc, { where: { id: doc.id } });
      expect(found!.tags).toEqual(["m1", "m2"]);
      expect(found!.meta).toEqual({ m: 1 });
      const [raw] = await rawRows("aoi_doc");
      expect(raw.tags).toBe('["m1","m2"]');
      expect(raw.meta).toBe('{"m":1}');
    });

    it("createUpdateBuilder().set() stringifies json columns", async () => {
      const doc = await seedDoc();

      await em
        .createUpdateBuilder(AoiDoc)
        .set({ tags: ["qb1", "qb2"], meta: { qb: 1 } })
        .where(sql`"id" = ${doc.id}`)
        .execute();

      const found = await em.findOne(AoiDoc, { where: { id: doc.id } });
      expect(found!.tags).toEqual(["qb1", "qb2"]);
      expect(found!.meta).toEqual({ qb: 1 });
    });

    it("updateMany() and createUpdateBuilder() run transformer.to", async () => {
      const doc = await seedDoc();
      expect((await rawRows("aoi_doc"))[0].email).toBe("seed@x.com");

      await em.updateMany(AoiDoc, { email: "C@X.COM" }, { where: { id: doc.id } });
      expect((await rawRows("aoi_doc"))[0].email).toBe("c@x.com");

      await em
        .createUpdateBuilder(AoiDoc)
        .set({ email: "D@X.COM" })
        .where(sql`"id" = ${doc.id}`)
        .execute();
      expect((await rawRows("aoi_doc"))[0].email).toBe("d@x.com");
    });

    it("keeps a Sql fragment verbatim on a text column in save() and updateMany()", async () => {
      const doc = await em.save(AoiDoc, {
        tags: [],
        meta: {},
        email: "a@x.com",
        label: sql`'lit' || 'eral'` as any,
      });
      expect((await rawRows("aoi_doc"))[0].label).toBe("literal");

      await em.updateMany(
        AoiDoc,
        { label: sql`upper("label")` as any },
        { where: { id: doc.id } },
      );
      expect((await rawRows("aoi_doc"))[0].label).toBe("LITERAL");
    });

    it("binds an FK shadow key in updateMany()", async () => {
      const owner = await em.save(AoiOwner, { name: "o" });
      const doc = await seedDoc();

      await em.updateMany(AoiDoc, { ownerId: owner.id }, { where: { id: doc.id } });
      expect((await rawRows("aoi_doc"))[0].ownerId).toBe(owner.id);
    });

    it("rejects an array bound to an FK shadow key in updateMany()", async () => {
      const doc = await seedDoc();

      const err = await captureError(() =>
        em.updateMany(AoiDoc, { ownerId: [1, 2] as any }, { where: { id: doc.id } }),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect((err as Error).message).toContain("ownerId");
    });
  });

  // ── 5. Transformer array column (legitimate text shape) ───────────────────

  describe("array property with a transformer and no type", () => {
    it("round-trips through save() as text", async () => {
      const saved = await em.save(AoiCsv, { tags: ["a", "b"] });
      expect((await rawRows("aoi_csv"))[0].tags).toBe("a,b");
      expect((await em.findOne(AoiCsv, { where: { id: saved.id } }))!.tags).toEqual(["a", "b"]);
    });

    it("runs the transformer in updateMany()", async () => {
      const saved = await em.save(AoiCsv, { tags: ["a", "b"] });

      await em.updateMany(AoiCsv, { tags: ["c", "d"] }, { where: { id: saved.id } });
      expect((await rawRows("aoi_csv"))[0].tags).toBe("c,d");
    });

    it("writes an array to a column whose transform is read-only", async () => {
      const saved = await em.save(AoiLegacy, { tags: ["a", "b"] });
      expect((await rawRows("aoi_legacy"))[0].tags).toBe('["a","b"]');
      expect(
        (await em.findOne(AoiLegacy, { where: { id: saved.id } }))!.tags,
      ).toEqual(["a", "b"]);
    });
  });

  // ── 6b. sql fragments on structured columns ───────────────────────────────

  describe("sql fragments on json and array columns", () => {
    it("splices a fragment into save() INSERT and UPDATE on a json column", async () => {
      const row = await em.save(AoiTagged, {
        slug: "frag",
        tags: sql`json_array('a','b')` as any,
      });
      expect((await rawRows("aoi_tagged"))[0].tags).toBe('["a","b"]');
      expect(
        (await em.findOne(AoiTagged, { where: { id: row.id } }))!.tags,
      ).toEqual(["a", "b"]);

      await em.save(AoiTagged, {
        id: row.id,
        slug: "frag",
        tags: sql`json_array('c')` as any,
      });
      expect((await rawRows("aoi_tagged"))[0].tags).toBe('["c"]');
    });

    it('splices a fragment into save() on a type: "array" column', async () => {
      const row = await em.save(AoiArr, { labels: sql`json_array('x')` as any });
      expect((await rawRows("aoi_arr"))[0].labels).toBe('["x"]');

      await em.save(AoiArr, {
        id: row.id,
        labels: sql`json_array('y','z')` as any,
      });
      expect((await rawRows("aoi_arr"))[0].labels).toBe('["y","z"]');
      expect(
        (await em.findOne(AoiArr, { where: { id: row.id } }))!.labels,
      ).toEqual(["y", "z"]);
    });

    it("rejects a plain data object shaped like a fragment", async () => {
      const err = await captureError(() =>
        em.save(AoiDoc, {
          tags: [],
          meta: {},
          email: "a",
          label: { strings: ["'lit'"], values: [] } as any,
        }),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect((err as Error).message).toContain("AoiDoc.label");
      expect((err as Error).message).toContain("save() received an object");
    });
  });

  // ── 6. type: "array" outside PostgreSQL ───────────────────────────────────

  describe('type: "array" on SQLite', () => {
    it("@Column({ type: \"array\" }) round-trips through JSON", async () => {
      const saved = await em.save(AoiArr, { labels: ["x", "y"] });
      expect((await rawRows("aoi_arr"))[0].labels).toBe('["x","y"]');
      expect((await em.findOne(AoiArr, { where: { id: saved.id } }))!.labels).toEqual(["x", "y"]);

      await em.updateMany(AoiArr, { labels: ["solo"] }, { where: { id: saved.id } });
      expect((await em.findOne(AoiArr, { where: { id: saved.id } }))!.labels).toEqual(["solo"]);
    });

    it("t.array<string>() round-trips through JSON", async () => {
      const saved = await em.save(AoiDefArr, { labels: ["x", "y"] } as any);
      expect((await rawRows("aoi_def_arr"))[0].labels).toBe('["x","y"]');
      const found = await em.findOne(AoiDefArr, { where: { id: (saved as any).id } } as any);
      expect((found as any).labels).toEqual(["x", "y"]);
    });
  });

  // ── 7. Non-scalar values on scalar columns ────────────────────────────────

  describe("non-scalar values on scalar columns", () => {
    it("rejects an array on a text column in save() and insertMany()", async () => {
      for (const run of [
        () => em.save(AoiDoc, { tags: [], meta: {}, email: "a", label: ["a", "b"] as any }),
        () => em.insertMany(AoiDoc, [{ tags: [], meta: {}, email: "a", label: [] as any }]),
      ]) {
        const err = await captureError(run);
        expect(err).toBeInstanceOf(InvalidQueryError);
        expect((err as Error).message).toContain("AoiDoc.label");
        expect((err as Error).message).toContain("array");
      }
      expect(await rawRows("aoi_doc")).toHaveLength(0);
    });

    it("rejects a nested DTO instance on a text column", async () => {
      const err = await captureError(() =>
        em.save(AoiDoc, { tags: [], meta: {}, email: "a", label: new MetaDto() as any }),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect((err as Error).message).toContain("AoiDoc.label");
    });

    it("stores a nested DTO instance on a json column", async () => {
      const saved = await em.save(AoiDoc, { tags: [], meta: new MetaDto() as any, email: "a" });
      expect((await em.findOne(AoiDoc, { where: { id: saved.id } }))!.meta).toEqual({ k: 1 });
    });

    it("rejects an array on a text column in updateMany() and createUpdateBuilder()", async () => {
      const doc = await em.save(AoiDoc, { tags: [], meta: {}, email: "a", label: "keep" });

      for (const run of [
        () => em.updateMany(AoiDoc, { label: ["p", "q"] as any }, { where: { id: doc.id } }),
        () =>
          em
            .createUpdateBuilder(AoiDoc)
            .set({ label: { k: 3 } as any })
            .where(sql`"id" = ${doc.id}`)
            .execute(),
      ]) {
        const err = await captureError(run);
        expect(err).toBeInstanceOf(InvalidQueryError);
        expect((err as Error).message).toContain("AoiDoc.label");
      }
      expect((await rawRows("aoi_doc"))[0].label).toBe("keep");
    });

    it("names update(), not the updateMany() it delegates to", async () => {
      const doc = await em.save(AoiDoc, { tags: [], meta: {}, email: "a", label: "keep" });

      const err = await captureError(() =>
        em.update(AoiDoc, { id: doc.id }, { label: ["p", "q"] as any }),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect((err as Error).message).toContain("update() received an array");
      expect((err as Error).message).not.toContain("updateMany()");
      expect((await rawRows("aoi_doc"))[0].label).toBe("keep");
    });
  });

  describe("SQLite connector array net", () => {
    it("rejects an array bound through a raw query", async () => {
      const err = await captureError(() => em.query("SELECT ? AS a, ? AS b", [[1, 2]]));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect((err as Error).message).toContain("array");
    });

    it("rejects an array bound through driver.queryWithOptions()", async () => {
      const driver = em.getDriver()!;
      const err = await captureError(() =>
        driver.queryWithOptions!(sql`SELECT ${[1, 2] as any} AS a, ${3} AS b`, {}),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
    });

    it("rejects an array operand in a where equality on a text column", async () => {
      await em.save(AoiDoc, { tags: [], meta: {}, email: "a", label: "a" });

      const err = await captureError(() =>
        em.find(AoiDoc, { where: { label: { eq: ["a"] as any } } }),
      );
      expect(err).toBeInstanceOf(InvalidQueryError);
    });

    it("still accepts a named-parameter bag in a raw query", async () => {
      const rows = await em.query("SELECT :a AS a", [{ a: 1 }]);
      expect(rows).toEqual([{ a: 1 }]);
    });

    it("still expands a top-level where array into IN", async () => {
      await em.save(AoiDoc, { tags: [], meta: {}, email: "a", label: "a" });
      await em.save(AoiDoc, { tags: [], meta: {}, email: "b", label: "b" });

      const rows = await em.find(AoiDoc, { where: { label: ["a", "b"] as any } });
      expect(rows).toHaveLength(2);
    });
  });
});
