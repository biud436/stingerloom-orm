/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: the tenant predicate must name the column the tenant
 * property actually maps to, not the property key.
 *
 * Regression: `applyNamingStrategyToEntities` rewrites `column.name` for every
 * non-explicit column (so `tenantId` becomes `tenant_id` in the DDL) but never
 * propagated the rename into `TENANT_COLUMN_TOKEN`. `resolveTenantColumnName`
 * read the property key back, so every tenant-scoped statement emitted
 * `"tenantId" = ?` against a table whose column is `tenant_id` — reads died
 * with `no such column`, and the write paths this file's siblings cover would
 * have emitted the same broken predicate.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { TenantColumn } from "../../../src/decorators/TenantColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";

async function makeEm(entities: any[], opts: Record<string, any> = {}) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities,
      synchronize: true,
      tenantStrategy: "tenant_column",
      namingStrategy: new SnakeNamingStrategy(),
      logging: false,
      ...opts,
    },
    `tcns_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function columnNames(em: EntityManager, table: string): Promise<string[]> {
  const driver = em.getDriver()!;
  const raw: any = await driver.executeRaw(`PRAGMA table_info("${table}")`);
  const rows: any[] = Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
  return rows.map((r) => r.name);
}

describe("[Integration] SQLite: tenant column name under a NamingStrategy", () => {
  beforeEach(() => MetadataContext.reset());

  describe("declared @TenantColumn with a camelCase property", () => {
    @Entity({ name: "tcns_declared_note" })
    class DeclaredNote {
      @PrimaryGeneratedColumn() id!: number;
      @Column() title!: string;
      @TenantColumn() tenantId!: string;
    }

    let em: EntityManager;

    beforeAll(async () => {
      em = await makeEm([DeclaredNote]);
      await MetadataContext.run("acme", () =>
        em.save(DeclaredNote, { title: "acme note" } as any),
      );
      await MetadataContext.run("globex", () =>
        em.save(DeclaredNote, { title: "globex note" } as any),
      );
    });

    afterAll(async () => {
      await em.propagateShutdown();
    });

    it("materializes the snake_case column", async () => {
      expect(await columnNames(em, "tcns_declared_note")).toEqual([
        "id",
        "title",
        "tenant_id",
      ]);
    });

    it("filters reads by the resolved column, not the property key", async () => {
      const rows = await MetadataContext.run("acme", () =>
        em.find(DeclaredNote, {}),
      );
      expect(rows.map((r: any) => r.title)).toEqual(["acme note"]);
    });

    it("keeps count() scoped", async () => {
      const acme = await MetadataContext.run("acme", () =>
        em.count(DeclaredNote),
      );
      const globex = await MetadataContext.run("globex", () =>
        em.count(DeclaredNote),
      );
      expect([acme, globex]).toEqual([1, 1]);
    });
  });

  describe("implicit injection with a camelCase tenantColumnName", () => {
    @Entity({ name: "tcns_implicit_note" })
    class ImplicitNote {
      @PrimaryGeneratedColumn() id!: number;
      @Column() title!: string;
    }

    let em: EntityManager;
    let ddlColumns: string[];

    beforeAll(async () => {
      em = await makeEm([ImplicitNote], { tenantColumnName: "tenantId" });
      ddlColumns = await columnNames(em, "tcns_implicit_note");
      await MetadataContext.run("acme", () =>
        em.save(ImplicitNote, { title: "acme note" } as any),
      );
      await MetadataContext.run("globex", () =>
        em.save(ImplicitNote, { title: "globex note" } as any),
      );
    });

    afterAll(async () => {
      await em.propagateShutdown();
    });

    it("scopes reads to the column the DDL actually created", async () => {
      // Whatever the naming strategy did to the injected column, the predicate
      // has to name that same column.
      const tenantColumn = ddlColumns.find((c) => /tenant/i.test(c));
      expect(tenantColumn).toBeDefined();

      const rows = await MetadataContext.run("acme", () =>
        em.find(ImplicitNote, {}),
      );
      expect(rows.map((r: any) => r.title)).toEqual(["acme note"]);
    });
  });
});
