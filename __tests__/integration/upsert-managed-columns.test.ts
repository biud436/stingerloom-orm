/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The upsert family maintains `@Version` / `@CreateTimestamp` /
 * `@UpdateTimestamp` / `@DeletedAt` against real servers (MySQL/MariaDB +
 * PostgreSQL).
 *
 * Mirrors __tests__/integration/sqlite/upsert-managed-columns.test.ts. The
 * dialect-specific part is the conflict branch: PostgreSQL has to qualify the
 * stored row (`"t"."version" + 1` — a bare column is ambiguous against
 * `EXCLUDED`), and MySQL folds the tenant guard into every assignment, the
 * version increment included (`IF(t.tenant_id = ?, t.version + 1, t.version)`).
 *
 * Temporal assertions compare values read back through the ORM with each
 * other rather than with literals, so DATETIME precision and session time
 * zones cannot make them flaky. MySQL's affected-rows count is not asserted
 * where it differs (`CLIENT_FOUND_ROWS`).
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { UniqueIndex } from "../../src/decorators/UniqueIndex";
import { Version } from "../../src/decorators/Version";
import { CreateTimestamp } from "../../src/decorators/CreateTimestamp";
import { UpdateTimestamp } from "../../src/decorators/UpdateTimestamp";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { OptimisticLockError } from "../../src/errors/OptimisticLockError";
import {
  createTestConnection,
  rawQuery,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const TABLES = {
  doc: "umci_doc",
  soft: "umci_soft",
  tag: "umci_tag",
  uuid: "umci_uuid",
  softTag: "umci_soft_tag",
  tenantDoc: "umci_tenant_doc",
  tenantSoft: "umci_tenant_soft",
} as const;

const OLD = new Date("2001-02-03T04:05:06.000Z");
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Doc = {
  id: number;
  slug: string;
  hits: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
type Soft = { id: number; slug: string; label: string; deletedAt?: Date | null };
type Tag = { id: number; slug: string; version: number };
type SoftTag = { id: number; slug: string; deletedAt?: Date | null };
type Uuid = { id: string; slug: string };
type TenantDoc = {
  id: number;
  slug: string;
  hits: number;
  version: number;
  updatedAt: Date;
};

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

describe.each(drivers)(
  "[Integration][$label] upsert maintains managed columns",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let DocE: new () => Doc;
    let SoftE: new () => Soft;
    let TagE: new () => Tag;
    let SoftTagE: new () => SoftTag;
    let UuidE: new () => Uuid;

    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLES.doc })
          @UniqueIndex(["slug"])
          class DocEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @Column({ type: "int" }) hits!: number;
            @Version() version!: number;
            @CreateTimestamp() createdAt!: Date;
            @UpdateTimestamp() updatedAt!: Date;
          }

          @Entity({ name: TABLES.soft })
          @UniqueIndex(["slug"])
          class SoftEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @Column({ type: "varchar", length: 64 }) label!: string;
            @DeletedAt() deletedAt?: Date | null;
          }

          @Entity({ name: TABLES.tag })
          @UniqueIndex(["slug"])
          class TagEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @Version() version!: number;
          }

          @Entity({ name: TABLES.softTag })
          @UniqueIndex(["slug"])
          class SoftTagEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @DeletedAt() deletedAt?: Date | null;
          }

          @Entity({ name: TABLES.uuid })
          @UniqueIndex(["slug"])
          class UuidEntity {
            @PrimaryGeneratedColumn("uuid") id!: string;
            @Column({ type: "varchar", length: 64 }) slug!: string;
          }

          DocE = DocEntity;
          SoftE = SoftEntity;
          TagE = TagEntity;
          SoftTagE = SoftTagEntity;
          UuidE = UuidEntity;
          return {
            entities: [DocEntity, SoftEntity, TagEntity, SoftTagEntity, UuidEntity],
          };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      for (const t of [TABLES.doc, TABLES.soft, TABLES.tag, TABLES.softTag, TABLES.uuid]) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    });

    beforeEach(async () => {
      for (const t of [TABLES.doc, TABLES.soft, TABLES.tag, TABLES.softTag]) {
        await truncateTestTable(t);
      }
      await rawQuery(`DELETE FROM ${q(TABLES.uuid)}`);
    });

    it("seeds version and timestamps on the INSERT branch of all three methods", async () => {
      await em.upsert(DocE, { slug: "u", hits: 1 }, ["slug"]);
      await em.insertIgnore(DocE, { slug: "i", hits: 1 }, ["slug"]);
      await em.batchUpsert(DocE, [{ slug: "b1", hits: 1 }, { slug: "b2", hits: 1 }], ["slug"]);

      const rows = await em.find(DocE, { orderBy: { slug: "ASC" } });
      expect(rows.map((r: any) => [r.slug, r.version])).toEqual([
        ["b1", 1],
        ["b2", 1],
        ["i", 1],
        ["u", 1],
      ]);
      for (const row of rows) {
        expect(row.createdAt).toBeInstanceOf(Date);
        expect(row.updatedAt).toBeInstanceOf(Date);
      }
    });

    it("increments the stored version, keeps createdAt and refreshes updatedAt on conflict", async () => {
      await em.save(DocE, { slug: "k", hits: 1, createdAt: OLD, updatedAt: OLD });
      const first = (await em.findOne(DocE, { where: { slug: "k" } }))!;
      await em.save(DocE, { ...first, hits: 2 });
      const before = (await em.findOne(DocE, { where: { slug: "k" } }))!;
      expect(before.version).toBe(2);

      await em.upsert(DocE, { slug: "k", hits: 9, version: 1, createdAt: new Date() }, ["slug"]);

      const after = (await em.findOne(DocE, { where: { slug: "k" } }))!;
      expect(after.hits).toBe(9);
      expect(after.version).toBe(3);
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
      expect(after.updatedAt.getTime() - before.createdAt.getTime()).toBeGreaterThan(
        ONE_YEAR_MS,
      );

      const stale = await (async () => {
        try {
          await em.save(DocE, { ...before, hits: 999 });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(stale).toBeInstanceOf(OptimisticLockError);
    });

    it("batchUpsert() bumps conflicting rows and seeds new ones in one statement", async () => {
      await em.upsert(DocE, { slug: "k", hits: 1 }, ["slug"]);

      await em.batchUpsert(DocE, [{ slug: "k", hits: 5 }, { slug: "n", hits: 6 }], ["slug"]);

      const rows = await em.find(DocE, { orderBy: { slug: "ASC" } });
      expect(rows.map((r: any) => [r.slug, r.hits, r.version])).toEqual([
        ["k", 5, 2],
        ["n", 6, 1],
      ]);
    });

    it("revives a conflicting soft-deleted row", async () => {
      await em.save(SoftE, { slug: "s", label: "old" });
      await em.softDelete(SoftE, { slug: "s" });

      await em.upsert(SoftE, { slug: "s", label: "new" }, ["slug"]);

      const rows = await em.find(SoftE);
      expect(rows).toHaveLength(1);
      expect(rows[0].label).toBe("new");
      expect(rows[0].deletedAt ?? null).toBeNull();
    });

    it("a key-only upsert revives a soft-deleted row and leaves a live one alone", async () => {
      await em.save(SoftTagE, { slug: "t" });
      await em.upsert(SoftTagE, { slug: "t" }, ["slug"]);
      expect(await em.find(SoftTagE)).toHaveLength(1);

      await em.softDelete(SoftTagE, { slug: "t" });
      expect(await em.find(SoftTagE)).toHaveLength(0);
      await em.upsert(SoftTagE, { slug: "t" }, ["slug"]);

      const rows = await em.find(SoftTagE);
      expect(rows.map((r) => r.slug)).toEqual(["t"]);
    });

    it("keeps the stored uuid key when a unique column conflicts", async () => {
      await em.upsert(UuidE, { slug: "k" }, ["slug"]);
      const [before] = rowsOf(await rawQuery(`SELECT ${q("id")} FROM ${q(TABLES.uuid)}`));

      await em.upsert(UuidE, { slug: "k" }, ["slug"]);
      await em.batchUpsert(UuidE, [{ slug: "k" }], ["slug"]);

      const after = rowsOf(await rawQuery(`SELECT ${q("id")} FROM ${q(TABLES.uuid)}`));
      expect(after.map((r: any) => String(r.id))).toEqual([String(before.id)]);
    });

    it("still inserts a payload naming only its conflict key, and leaves a conflict untouched", async () => {
      await em.upsert(TagE, { slug: "x" }, ["slug"]);
      await em.upsert(TagE, { slug: "x" }, ["slug"]);
      await em.batchUpsert(TagE, [{ slug: "x" }, { slug: "y" }], ["slug"]);

      const rows = rowsOf(
        await rawQuery(`SELECT ${q("slug")}, ${q("version")} FROM ${q(TABLES.tag)} ORDER BY ${q("slug")}`),
      );
      expect(rows.map((r: any) => [r.slug, Number(r.version)])).toEqual([
        ["x", 1],
        ["y", 1],
      ]);
    });

    it("generates uuid primary keys on the bulk and upsert paths", async () => {
      await em.insertMany(UuidE, [{ slug: "many" }]);
      await em.upsert(UuidE, { slug: "upserted" }, ["slug"]);
      await em.insertIgnore(UuidE, { slug: "ignored" }, ["slug"]);
      await em.batchUpsert(UuidE, [{ slug: "b1" }, { slug: "b2" }], ["slug"]);

      const rows = rowsOf(await rawQuery(`SELECT ${q("id")} FROM ${q(TABLES.uuid)}`));
      expect(rows).toHaveLength(5);
      for (const row of rows) expect(String(row.id)).toMatch(UUID_RE);
    });
  },
);

describe.each(drivers)(
  "[Integration][$label] upsert managed columns under tenant_column",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let TenantDocE: new () => TenantDoc;
    let TenantSoftE: new () => SoftTag;

    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          tenantStrategy: "tenant_column",
        },
        () => {
          @Entity({ name: TABLES.tenantDoc })
          @UniqueIndex(["slug"])
          class TenantDocEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @Column({ type: "int" }) hits!: number;
            @Version() version!: number;
            @UpdateTimestamp() updatedAt!: Date;
          }

          @Entity({ name: TABLES.tenantSoft })
          @UniqueIndex(["slug"])
          class TenantSoftEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 64 }) slug!: string;
            @DeletedAt() deletedAt?: Date | null;
          }

          TenantDocE = TenantDocEntity;
          TenantSoftE = TenantSoftEntity;
          return { entities: [TenantDocEntity, TenantSoftEntity] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      for (const t of [TABLES.tenantDoc, TABLES.tenantSoft]) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    });

    beforeEach(async () => {
      await truncateTestTable(TABLES.tenantDoc);
      await truncateTestTable(TABLES.tenantSoft);
    });

    it("never revives another tenant's soft-deleted row", async () => {
      await MetadataContext.run("globex", async () => {
        await em.save(TenantSoftE, { slug: "g" });
        await em.softDelete(TenantSoftE, { slug: "g" });
      });

      await MetadataContext.run("acme", () =>
        em.upsert(TenantSoftE, { slug: "g" }, ["slug"]),
      );
      await MetadataContext.run("acme", () =>
        em.batchUpsert(TenantSoftE, [{ slug: "g" }], ["slug"]),
      );

      const rows = rowsOf(
        await rawQuery(
          `SELECT ${q("tenant_id")}, ${q("deletedAt")} FROM ${q(TABLES.tenantSoft)}`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe("globex");
      expect(rows[0].deletedAt).not.toBeNull();
    });

    it("bumps the caller's own row and leaves a foreign row's version alone", async () => {
      await MetadataContext.run("globex", () =>
        em.upsert(TenantDocE, { slug: "g", hits: 1 }, ["slug"]),
      );
      await MetadataContext.run("acme", () =>
        em.upsert(TenantDocE, { slug: "a", hits: 1 }, ["slug"]),
      );

      await MetadataContext.run("acme", () =>
        em.upsert(TenantDocE, { slug: "a", hits: 2 }, ["slug"]),
      );
      await MetadataContext.run("acme", () =>
        em.batchUpsert(TenantDocE, [{ slug: "g", hits: 99 }, { slug: "a", hits: 3 }], ["slug"]),
      );

      const rows = rowsOf(
        await rawQuery(
          `SELECT ${q("slug")}, ${q("hits")}, ${q("version")}, ${q("tenant_id")} FROM ${q(TABLES.tenantDoc)} ORDER BY ${q("slug")}`,
        ),
      );
      expect(
        rows.map((r: any) => [r.slug, Number(r.hits), Number(r.version), r.tenant_id]),
      ).toEqual([
        ["a", 3, 3, "acme"],
        ["g", 1, 1, "globex"],
      ]);
    });
  },
);
