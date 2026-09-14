/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: the upsert family and the bulk INSERT paths maintain the
 * ORM-managed columns the way save() / saveMany() do.
 *
 * Regression (V6-T0-4):
 *
 *   - `upsert()` / `insertIgnore()` / `batchUpsert()` never seeded `@Version`,
 *     `@CreateTimestamp` or `@UpdateTimestamp`, so every call on such an
 *     entity died on NOT NULL — or, over a nullable legacy schema, silently
 *     stored NULL and disabled optimistic locking for the row's lifetime.
 *   - Passing the values by hand got past the crash, but the conflict branch
 *     overwrote them: `version` went backwards (a stale save() was then
 *     accepted) and `createdAt` was replaced.
 *   - A conflicting soft-deleted row was updated but left trashed: 1 affected,
 *     0 visible, and the key could never be inserted again.
 *   - A payload stating only conflict-target columns emitted no statement at
 *     all and reported `{ affected: 0 }` — a missing row was never inserted.
 *   - `insertMany()` / `insertManyAndReturn()` / `createInsertBuilder()` chose
 *     the columns to stamp by type: every plain `datetime` column got `now()`,
 *     while `@CreateTimestamp({ type: "timestamptz" })` got nothing.
 *   - None of the bulk or upsert paths generated `uuid` / `uuid-v7` keys.
 *   - Those three bulk paths also named every declared column and bound NULL
 *     for the ones no row provided; with the type-based stamping gone that
 *     would have turned a `@Column({ default: "(CURRENT_TIMESTAMP)" })` into
 *     a NOT NULL failure. A column no row provides is now left out so the
 *     DB DEFAULT applies, as in save() / saveMany() (#368).
 *
 * Found while fixing it: a primary key the payload states (or the ORM
 * generates) was in the conflict branch's SET list, so an upsert on a unique
 * column rewrote the stored row's key.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { UniqueIndex } from "../../../src/decorators/UniqueIndex";
import { Version } from "../../../src/decorators/Version";
import { CreateTimestamp } from "../../../src/decorators/CreateTimestamp";
import { UpdateTimestamp } from "../../../src/decorators/UpdateTimestamp";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { EntityManager } from "../../../src/core/EntityManager";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OptimisticLockError } from "../../../src/errors/OptimisticLockError";

// ── Entities ────────────────────────────────────────────────────────────────

@Entity({ name: "umc_doc" })
@UniqueIndex(["slug"])
class UmcDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) hits!: number;
  @Version() version!: number;
  @CreateTimestamp() createdAt!: Date;
  @UpdateTimestamp() updatedAt!: Date;
}

@Entity({ name: "umc_ts_only" })
@UniqueIndex(["slug"])
class UmcTsOnly {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) hits!: number;
  @CreateTimestamp() createdAt!: Date;
  @UpdateTimestamp() updatedAt!: Date;
}

@Entity({ name: "umc_ver_only" })
@UniqueIndex(["slug"])
class UmcVerOnly {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) hits!: number;
  @Version() version!: number;
}

@Entity({ name: "umc_soft" })
@UniqueIndex(["slug"])
class UmcSoft {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column() label!: string;
  @DeletedAt() deletedAt?: Date | null;
}

/** Soft delete with nothing but the conflict key to write. */
@Entity({ name: "umc_soft_tag" })
@UniqueIndex(["slug"])
class UmcSoftTag {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @DeletedAt() deletedAt?: Date | null;
}

/** Nothing to write on conflict: the only column is the conflict target. */
@Entity({ name: "umc_tag" })
@UniqueIndex(["slug"])
class UmcTag {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
}

/** Same, but with managed columns — they must not turn a no-op into a write. */
@Entity({ name: "umc_tag_managed" })
@UniqueIndex(["slug"])
class UmcTagManaged {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Version() version!: number;
  @CreateTimestamp() createdAt!: Date;
}

/** A plain temporal column next to a managed one. */
@Entity({ name: "umc_task" })
class UmcTask {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ type: "datetime", nullable: true }) dueAt?: Date | null;
  @CreateTimestamp() createdAt!: Date;
}

/** DB-side defaults, the documented `@Column({ default })` forms. */
@Entity({ name: "umc_defaults" })
class UmcDefaults {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ default: "active" }) status!: string;
  @Column({ type: "datetime", default: "(CURRENT_TIMESTAMP)" }) postedAt!: Date;
}

@Entity({ name: "umc_tz" })
@UniqueIndex(["slug"])
class UmcTz {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @CreateTimestamp({ type: "timestamptz" }) createdAt!: Date;
  @UpdateTimestamp({ type: "timestamptz" }) updatedAt!: Date;
}

@Entity({ name: "umc_uuid" })
@UniqueIndex(["slug"])
class UmcUuid {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column() slug!: string;
}

@Entity({ name: "umc_uuid7" })
@UniqueIndex(["slug"])
class UmcUuid7 {
  @PrimaryGeneratedColumn("uuid-v7") id!: string;
  @Column() slug!: string;
}

const ENTITIES = [
  UmcDoc,
  UmcTsOnly,
  UmcVerOnly,
  UmcSoft,
  UmcSoftTag,
  UmcTag,
  UmcTagManaged,
  UmcTask,
  UmcDefaults,
  UmcTz,
  UmcUuid,
  UmcUuid7,
];

/** Registered only on the snake_case connection. */
@Entity({ name: "umc_snake" })
@UniqueIndex(["slug"])
class UmcSnake {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) hitCount!: number;
  @Version() rowVersion!: number;
  @CreateTimestamp() createdAt!: Date;
  @UpdateTimestamp() updatedAt!: Date;
}

/** Registered only on the tenant_column connection. */
@Entity({ name: "umc_tenant_doc" })
@UniqueIndex(["slug"])
class UmcTenantDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) hits!: number;
  @Version() version!: number;
  @CreateTimestamp() createdAt!: Date;
  @UpdateTimestamp() updatedAt!: Date;
}

/** Registered with synchronize: false over a hand-made nullable table. */
@Entity({ name: "umc_legacy" })
class UmcLegacy {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) hits!: number;
  @Version() version!: number;
  @CreateTimestamp() createdAt!: Date;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const OLD = new Date("2001-02-03T04:05:06.000Z");
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function makeEm(
  entities: any[],
  opts: Record<string, any> = {},
): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities,
      synchronize: true,
      logging: false,
      ...opts,
    },
    `umc_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function rawRows(em: EntityManager, sqlText: string): Promise<any[]> {
  const result: any = await em.getDriver()!.executeRaw(sqlText);
  return Array.isArray(result) ? result : (result.results ?? result.rows ?? []);
}

async function errorOf(fn: () => unknown | Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function expectRecent(value: unknown): void {
  expect(value).toBeInstanceOf(Date);
  expect((value as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
}

describe("[Integration] SQLite: upsert family and bulk INSERT maintain managed columns", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm(ENTITIES);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INSERT branch: the managed columns are seeded
  // ─────────────────────────────────────────────────────────────────────────
  describe("INSERT branch seeds @Version / @CreateTimestamp / @UpdateTimestamp", () => {
    it("upsert() inserts a new row with version 1 and both timestamps", async () => {
      const result = await em.upsert(UmcDoc, { slug: "a", hits: 1 }, ["slug"]);

      expect(result.affected).toBe(1);
      const row = await em.findOne(UmcDoc, { where: { slug: "a" } });
      expect(row).toMatchObject({ slug: "a", hits: 1, version: 1 });
      expectRecent(row!.createdAt);
      expectRecent(row!.updatedAt);
    });

    it("insertIgnore() inserts a new row with version 1 and both timestamps", async () => {
      const result = await em.insertIgnore(UmcDoc, { slug: "b", hits: 2 }, [
        "slug",
      ]);

      expect(result.affected).toBe(1);
      const row = await em.findOne(UmcDoc, { where: { slug: "b" } });
      expect(row).toMatchObject({ slug: "b", hits: 2, version: 1 });
      expectRecent(row!.createdAt);
      expectRecent(row!.updatedAt);
    });

    it("batchUpsert() seeds every new row", async () => {
      const result = await em.batchUpsert(
        UmcDoc,
        [
          { slug: "c1", hits: 1 },
          { slug: "c2", hits: 2 },
        ],
        ["slug"],
      );

      expect(result.affected).toBe(2);
      const rows = await em.find(UmcDoc, { orderBy: { slug: "ASC" } });
      expect(rows.map((r) => [r.slug, r.version])).toEqual([
        ["c1", 1],
        ["c2", 1],
      ]);
      for (const row of rows) {
        expectRecent(row.createdAt);
        expectRecent(row.updatedAt);
      }
    });

    it("seeds a timestamps-only entity and a version-only entity", async () => {
      await em.upsert(UmcTsOnly, { slug: "t", hits: 1 }, ["slug"]);
      await em.upsert(UmcVerOnly, { slug: "v", hits: 1 }, ["slug"]);

      const ts = await em.findOne(UmcTsOnly, { where: { slug: "t" } });
      expectRecent(ts!.createdAt);
      expectRecent(ts!.updatedAt);
      const ver = await em.findOne(UmcVerOnly, { where: { slug: "v" } });
      expect(ver!.version).toBe(1);
    });

    it("keeps a stated version / timestamp on INSERT, like insertMany()", async () => {
      await em.upsert(
        UmcDoc,
        { slug: "given", hits: 1, version: 5, createdAt: OLD, updatedAt: OLD },
        ["slug"],
      );

      const row = await em.findOne(UmcDoc, { where: { slug: "given" } });
      expect(row!.version).toBe(5);
      expect(row!.createdAt.toISOString()).toBe(OLD.toISOString());
      expect(row!.updatedAt.toISOString()).toBe(OLD.toISOString());
    });

    it("does not write the seeded values back onto the caller's payload", async () => {
      const payload = { slug: "p", hits: 1 };
      const items = [{ slug: "p2", hits: 1 }];

      await em.upsert(UmcDoc, payload, ["slug"]);
      await em.insertIgnore(UmcDoc, { ...payload, slug: "p1" }, ["slug"]);
      await em.batchUpsert(UmcDoc, items, ["slug"]);

      expect(payload).toEqual({ slug: "p", hits: 1 });
      expect(items).toEqual([{ slug: "p2", hits: 1 }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Conflict branch: version bumps, createdAt survives, updatedAt refreshes
  // ─────────────────────────────────────────────────────────────────────────
  describe("conflict branch", () => {
    let original: UmcDoc;

    beforeEach(async () => {
      await em.save(UmcDoc, {
        slug: "k",
        hits: 1,
        createdAt: OLD,
        updatedAt: OLD,
      } as any);
      // A second save moves the row to version 2 before any upsert.
      const saved = await em.findOne(UmcDoc, { where: { slug: "k" } });
      await em.save(UmcDoc, { ...saved!, hits: 2 });
      original = (await em.findOne(UmcDoc, { where: { slug: "k" } }))!;
      expect(original.version).toBe(2);
    });

    it("upsert() increments the stored version, keeps createdAt, refreshes updatedAt", async () => {
      const result = await em.upsert(UmcDoc, { slug: "k", hits: 9 }, ["slug"]);

      expect(result.affected).toBe(1);
      const row = await em.findOne(UmcDoc, { where: { slug: "k" } });
      expect(row!.hits).toBe(9);
      expect(row!.version).toBe(3);
      expect(row!.createdAt.toISOString()).toBe(OLD.toISOString());
      expectRecent(row!.updatedAt);
    });

    it("upsert() ignores a stated version and createdAt on conflict", async () => {
      const warn = jest.spyOn((em as any).logger, "warn");
      try {
        await em.upsert(
          UmcDoc,
          { slug: "k", hits: 9, version: 1, createdAt: new Date("2000-01-01") },
          ["slug"],
        );
        await em.upsert(UmcDoc, { slug: "k", hits: 10, version: 1 }, ["slug"]);

        const row = await em.findOne(UmcDoc, { where: { slug: "k" } });
        expect(row!.hits).toBe(10);
        expect(row!.version).toBe(4);
        expect(row!.createdAt.toISOString()).toBe(OLD.toISOString());

        const versionWarnings = warn.mock.calls.filter((call) =>
          String(call[0]).includes("@Version"),
        );
        expect(versionWarnings).toHaveLength(1);
        expect(String(versionWarnings[0][0])).toContain("UmcDoc");
      } finally {
        warn.mockRestore();
      }
    });

    it("a save() holding the pre-upsert version is rejected afterwards", async () => {
      await em.upsert(UmcDoc, { slug: "k", hits: 50, version: 1 }, ["slug"]);

      const error = await errorOf(() =>
        em.save(UmcDoc, { ...original, hits: 999 }),
      );

      expect(error).toBeInstanceOf(OptimisticLockError);
      const row = await em.findOne(UmcDoc, { where: { slug: "k" } });
      expect(row!.hits).toBe(50);
    });

    it("batchUpsert() bumps existing rows and seeds new ones in one statement", async () => {
      const result = await em.batchUpsert(
        UmcDoc,
        [
          { slug: "k", hits: 70 },
          { slug: "fresh", hits: 1 },
        ],
        ["slug"],
      );

      expect(result.affected).toBe(2);
      const existing = await em.findOne(UmcDoc, { where: { slug: "k" } });
      expect(existing).toMatchObject({ hits: 70, version: 3 });
      expect(existing!.createdAt.toISOString()).toBe(OLD.toISOString());
      expectRecent(existing!.updatedAt);
      const fresh = await em.findOne(UmcDoc, { where: { slug: "fresh" } });
      expect(fresh).toMatchObject({ hits: 1, version: 1 });
    });

    it("insertIgnore() leaves a conflicting row exactly as it was", async () => {
      const result = await em.insertIgnore(
        UmcDoc,
        { slug: "k", hits: 123, version: 1 },
        ["slug"],
      );

      expect(result.affected).toBe(0);
      const row = await em.findOne(UmcDoc, { where: { slug: "k" } });
      expect(row!.hits).toBe(2);
      expect(row!.version).toBe(2);
      expect(row!.updatedAt.getTime()).toBe(original.updatedAt.getTime());
    });

    it("an upsert that fails the NOT NULL check does not leave a partial row", async () => {
      // Sanity pin for the loud path: an explicit null on a NOT NULL user
      // column still fails, managed columns do not mask it.
      const error = await errorOf(() =>
        em.upsert(UmcDoc, { slug: "nn", hits: null } as any, ["slug"]),
      );
      expect(error).not.toBeNull();
      expect(await em.findOne(UmcDoc, { where: { slug: "nn" } })).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Soft delete
  // ─────────────────────────────────────────────────────────────────────────
  describe("a conflicting soft-deleted row", () => {
    beforeEach(async () => {
      await em.save(UmcSoft, { slug: "s", label: "old" } as any);
      await em.softDelete(UmcSoft, { slug: "s" });
      expect(await em.find(UmcSoft)).toEqual([]);
    });

    it("upsert() revives it with the proposed values", async () => {
      const result = await em.upsert(UmcSoft, { slug: "s", label: "new" }, [
        "slug",
      ]);

      expect(result.affected).toBe(1);
      const rows = await em.find(UmcSoft);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ slug: "s", label: "new" });
      expect(rows[0].deletedAt ?? null).toBeNull();
    });

    it("batchUpsert() revives it as well", async () => {
      await em.batchUpsert(
        UmcSoft,
        [
          { slug: "s", label: "batch" },
          { slug: "s2", label: "other" },
        ],
        ["slug"],
      );

      const rows = await em.find(UmcSoft, { orderBy: { slug: "ASC" } });
      expect(rows.map((r) => [r.slug, r.label])).toEqual([
        ["s", "batch"],
        ["s2", "other"],
      ]);
    });

    it("upsert() honours a deletedAt the payload states", async () => {
      await em.upsert(UmcSoft, { slug: "s", label: "still gone", deletedAt: OLD }, [
        "slug",
      ]);

      expect(await em.find(UmcSoft)).toEqual([]);
      const [row] = await rawRows(em, `SELECT * FROM "umc_soft"`);
      expect(row.label).toBe("still gone");
      expect(row.deletedAt).not.toBeNull();
    });

    it("upsert() revives it even when the payload names only its conflict key", async () => {
      await em.save(UmcSoftTag, { slug: "t" } as any);
      await em.softDelete(UmcSoftTag, { slug: "t" });

      const result = await em.upsert(UmcSoftTag, { slug: "t" }, ["slug"]);
      const again = await em.upsert(UmcSoftTag, { slug: "t" }, ["slug"]);
      await em.softDelete(UmcSoftTag, { slug: "t" });
      await em.batchUpsert(UmcSoftTag, [{ slug: "t" }, { slug: "t2" }], ["slug"]);

      expect(result.affected).toBe(1);
      // A live conflicting row is left alone.
      expect(again.affected).toBe(0);
      const rows = await em.find(UmcSoftTag, { orderBy: { slug: "ASC" } });
      expect(rows.map((r) => r.slug)).toEqual(["t", "t2"]);
    });

    it("insertIgnore() leaves it trashed", async () => {
      const result = await em.insertIgnore(
        UmcSoft,
        { slug: "s", label: "ignored" },
        ["slug"],
      );

      expect(result.affected).toBe(0);
      expect(await em.find(UmcSoft)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The primary key identifies the stored row
  // ─────────────────────────────────────────────────────────────────────────
  describe("the primary key on conflict", () => {
    it("a generated uuid key does not replace the stored one", async () => {
      await em.upsert(UmcUuid, { slug: "u" }, ["slug"]);
      const [before] = await rawRows(em, `SELECT id FROM "umc_uuid"`);

      await em.upsert(UmcUuid, { slug: "u" }, ["slug"]);
      await em.batchUpsert(UmcUuid, [{ slug: "u" }], ["slug"]);

      expect(await rawRows(em, `SELECT id FROM "umc_uuid"`)).toEqual([before]);
    });

    it("a stated key does not rewrite the stored one on a unique-column conflict", async () => {
      await em.upsert(UmcDoc, { slug: "pk", hits: 1 }, ["slug"]);
      const stored = await em.findOne(UmcDoc, { where: { slug: "pk" } });

      await em.upsert(UmcDoc, { id: 999, slug: "pk", hits: 2 }, ["slug"]);

      const rows = await rawRows(em, `SELECT id, hits FROM "umc_doc"`);
      expect(rows).toEqual([{ id: stored!.id, hits: 2 }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Nothing to write on conflict
  // ─────────────────────────────────────────────────────────────────────────
  describe("a payload with nothing to write on conflict", () => {
    it("upsert() still inserts a missing row", async () => {
      const first = await em.upsert(UmcTag, { slug: "x" }, ["slug"]);
      const second = await em.upsert(UmcTag, { slug: "x" }, ["slug"]);

      expect(first.affected).toBe(1);
      expect(second.affected).toBe(0);
      expect(await rawRows(em, `SELECT slug FROM "umc_tag"`)).toEqual([
        { slug: "x" },
      ]);
    });

    it("batchUpsert() still inserts the missing rows", async () => {
      await em.upsert(UmcTag, { slug: "x" }, ["slug"]);

      const result = await em.batchUpsert(
        UmcTag,
        [{ slug: "x" }, { slug: "y" }],
        ["slug"],
      );

      expect(result.affected).toBe(1);
      expect(
        await rawRows(em, `SELECT slug FROM "umc_tag" ORDER BY slug`),
      ).toEqual([{ slug: "x" }, { slug: "y" }]);
    });

    it("managed columns alone do not turn the conflict into a write", async () => {
      await em.upsert(UmcTagManaged, { slug: "m" }, ["slug"]);
      const before = await em.findOne(UmcTagManaged, { where: { slug: "m" } });

      const result = await em.upsert(UmcTagManaged, { slug: "m" }, ["slug"]);

      expect(result.affected).toBe(0);
      const after = await em.findOne(UmcTagManaged, { where: { slug: "m" } });
      expect(before!.version).toBe(1);
      expect(after!.version).toBe(1);
      expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bulk INSERT paths pick managed columns by decorator, not by type
  // ─────────────────────────────────────────────────────────────────────────
  describe("insertMany() / insertManyAndReturn() / createInsertBuilder()", () => {
    it("leave a plain datetime column NULL", async () => {
      await em.insertMany(UmcTask, [{ title: "many" }]);
      await em.insertManyAndReturn(UmcTask, [{ title: "returned" }]);
      await em.createInsertBuilder(UmcTask).values({ title: "built" }).execute();
      await em.upsert(UmcTask, { title: "upserted" } as any);
      await em.save(UmcTask, { title: "saved" } as any);

      const rows = await em.find(UmcTask, { orderBy: { id: "ASC" } });
      expect(rows.map((r) => [r.title, r.dueAt ?? null])).toEqual([
        ["many", null],
        ["returned", null],
        ["built", null],
        ["upserted", null],
        ["saved", null],
      ]);
      for (const row of rows) expectRecent(row.createdAt);
    });

    it("leave a column no row provides to its DB DEFAULT", async () => {
      await em.insertMany(UmcDefaults, [{ title: "many" }, { title: "many2" }]);
      const returned = await em.insertManyAndReturn(UmcDefaults, [
        { title: "returned" },
      ]);
      await em
        .createInsertBuilder(UmcDefaults)
        .values({ title: "built" })
        .execute();

      expect(returned[0].status).toBe("active");
      const rows = await rawRows(
        em,
        `SELECT title, status, postedAt FROM "umc_defaults" ORDER BY id`,
      );
      expect(rows.map((r) => [r.title, r.status])).toEqual([
        ["many", "active"],
        ["many2", "active"],
        ["returned", "active"],
        ["built", "active"],
      ]);
      for (const row of rows) expect(row.postedAt).not.toBeNull();
    });

    it("seed @CreateTimestamp / @UpdateTimestamp of type timestamptz", async () => {
      await em.insertMany(UmcTz, [{ slug: "many" }]);
      await em.insertManyAndReturn(UmcTz, [{ slug: "returned" }]);
      await em.createInsertBuilder(UmcTz).values({ slug: "built" }).execute();
      await em.upsert(UmcTz, { slug: "upserted" }, ["slug"]);

      const rows = await em.find(UmcTz);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expectRecent(row.createdAt);
        expectRecent(row.updatedAt);
      }
    });

    it("still write the seeded values onto the items they were given", async () => {
      const items: Partial<UmcDoc>[] = [{ slug: "im", hits: 1 }];

      await em.insertMany(UmcDoc, items);

      expect(items[0].version).toBe(1);
      expectRecent(items[0].createdAt);
      expectRecent(items[0].updatedAt);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Client-side UUID keys
  // ─────────────────────────────────────────────────────────────────────────
  describe.each([
    ["uuid", UmcUuid, "umc_uuid"],
    ["uuid-v7", UmcUuid7, "umc_uuid7"],
  ] as const)("%s primary keys", (_strategy, Klass, table) => {
    it("are generated by every bulk and upsert path", async () => {
      await em.insertMany(Klass, [{ slug: "many" }]);
      const returned = await em.insertManyAndReturn(Klass, [
        { slug: "returned" },
      ]);
      await em.createInsertBuilder(Klass).values({ slug: "built" }).execute();
      await em.upsert(Klass, { slug: "upserted" }, ["slug"]);
      await em.insertIgnore(Klass, { slug: "ignored" }, ["slug"]);
      await em.batchUpsert(Klass, [{ slug: "b1" }, { slug: "b2" }], ["slug"]);

      expect(returned[0].id).toMatch(UUID_RE);
      const rows = await rawRows(em, `SELECT id, slug FROM "${table}"`);
      expect(rows).toHaveLength(7);
      for (const row of rows) expect(row.id).toMatch(UUID_RE);
      expect(new Set(rows.map((r) => r.id)).size).toBe(7);
    });
  });
});

describe("[Integration] SQLite: upsert managed columns under SnakeNamingStrategy", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm([UmcSnake], { namingStrategy: new SnakeNamingStrategy() });
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("seeds and maintains the renamed columns", async () => {
    await em.upsert(UmcSnake, { slug: "a", hitCount: 1 }, ["slug"]);
    await em.upsert(UmcSnake, { slug: "a", hitCount: 2 }, ["slug"]);
    await em.batchUpsert(UmcSnake, [{ slug: "a", hitCount: 3 }], ["slug"]);

    const [row] = await rawRows(
      em,
      `SELECT hit_count, row_version, created_at, updated_at FROM "umc_snake"`,
    );
    expect(row.hit_count).toBe(3);
    expect(row.row_version).toBe(3);
    expect(row.created_at).not.toBeNull();
    expect(row.updated_at).not.toBeNull();
  });
});

describe("[Integration] SQLite: upsert managed columns under tenant_column", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm([UmcTenantDoc], { tenantStrategy: "tenant_column" });
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("bumps the version of the caller's own row only", async () => {
    await MetadataContext.run("globex", () =>
      em.upsert(UmcTenantDoc, { slug: "g", hits: 1 }, ["slug"]),
    );
    await MetadataContext.run("acme", () =>
      em.upsert(UmcTenantDoc, { slug: "a", hits: 1 }, ["slug"]),
    );

    const own = await MetadataContext.run("acme", () =>
      em.upsert(UmcTenantDoc, { slug: "a", hits: 2 }, ["slug"]),
    );
    const foreign = await MetadataContext.run("acme", () =>
      em.upsert(UmcTenantDoc, { slug: "g", hits: 99 }, ["slug"]),
    );

    expect(own.affected).toBe(1);
    expect(foreign.affected).toBe(0);

    // The tenant column is filled on a copy too.
    const payload = { slug: "a", hits: 3 };
    await MetadataContext.run("acme", () =>
      em.upsert(UmcTenantDoc, payload, ["slug"]),
    );
    expect(payload).toEqual({ slug: "a", hits: 3 });
    const rows = await rawRows(
      em,
      `SELECT slug, hits, version, tenant_id FROM "umc_tenant_doc" ORDER BY slug`,
    );
    expect(rows).toEqual([
      { slug: "a", hits: 3, version: 3, tenant_id: "acme" },
      { slug: "g", hits: 1, version: 1, tenant_id: "globex" },
    ]);
  });
});

describe("[Integration] SQLite: upsert over a nullable legacy schema", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm([UmcLegacy], { synchronize: false });
    await em
      .getDriver()!
      .executeRaw(
        `CREATE TABLE "umc_legacy" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "slug" TEXT UNIQUE, "hits" INTEGER, "version" INTEGER NULL, "createdAt" TEXT NULL)`,
      );
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("counts a stored NULL version as 0 on conflict", async () => {
    await em
      .getDriver()!
      .executeRaw(
        `INSERT INTO "umc_legacy" ("slug", "hits", "version", "createdAt") VALUES ('old', 1, NULL, NULL)`,
      );

    await em.upsert(UmcLegacy, { slug: "old", hits: 2 }, ["slug"]);

    const [row] = await rawRows(em, `SELECT hits, version FROM "umc_legacy"`);
    expect(row).toEqual({ hits: 2, version: 1 });
  });

  it("stores a real version and creation time instead of NULL", async () => {
    await em.upsert(UmcLegacy, { slug: "L", hits: 1 }, ["slug"]);
    await em.upsert(UmcLegacy, { slug: "L", hits: 2 }, ["slug"]);

    const [row] = await rawRows(
      em,
      `SELECT hits, version, createdAt FROM "umc_legacy"`,
    );
    expect(row.hits).toBe(2);
    expect(row.version).toBe(2);
    expect(row.createdAt).not.toBeNull();
  });
});
