/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WriteBuffer `batchInsert` on a real PostgreSQL / MySQL (MariaDB): the
 * multi-row INSERT writes what save() writes for each row.
 *
 * The batch path built its own INSERT from the raw instance values, so it
 * sent NULL for a column left to its declared default (NOT NULL violation),
 * skipped column transformers, bound JSON objects as-is (MySQL rejected the
 * row), left the tenant column NULL under `tenant_column`, and ran no
 * lifecycle hooks. The group now goes through saveMany().
 *
 * SQLite writes a batch group one row at a time:
 * __tests__/integration/sqlite/buffer-flush-entity-hooks.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryGeneratedColumn, BeforeInsert } from "../../src";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../src/core/plugin/buffer/WriteBuffer";
import { createTestConnection, dropTestTable, rawQuery, type TestConnectionResult } from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const suffix = String(Date.now()).slice(-6);

describe.each(getTestDrivers())(
  "[Integration] $label: WriteBuffer batchInsert writes what save() writes",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Item: any;
    const table = `bbip_item_${suffix}`;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false, plugins: [bufferPlugin()] },
        () => {
          @Entity({ name: table })
          class BatchItem {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @Column({
              type: "varchar",
              length: 40,
              transformer: { to: (v: any) => (v == null ? v : `code:${v}`), from: (v: any) => v },
            })
            code!: string;
            @Column({ type: "json", nullable: true }) meta!: any;
            @Column({ type: "varchar", length: 20, default: "draft" }) status!: string;
            @Column({ type: "varchar", length: 40, nullable: true }) slug!: string | null;

            @BeforeInsert() makeSlug() {
              this.slug = `slug-${this.name}`;
            }
          }
          Item = BatchItem;
          return { entities: [BatchItem] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("stores defaults, transformed values, JSON and hook output for every row", async () => {
      const buf: WriteBuffer = (em as any).buffer({ batchInsert: true });
      const a = Object.assign(new Item(), { name: "a", code: "x1", meta: { tags: ["red"] } });
      const b = Object.assign(new Item(), { name: "b", code: "x2", meta: { tags: [] }, status: "live" });
      buf.persist(a).persist(b);

      const result = await buf.flush();
      expect(result.inserts).toBe(2);

      const q = (name: string) => (type === "postgres" ? `"${name}"` : `\`${name}\``);
      const rows: any[] = await rawQuery(
        `SELECT ${q("id")}, ${q("code")}, ${q("meta")}, ${q("status")}, ${q("slug")} FROM ${q(table)} WHERE ${q("id")} IN (${a.id}, ${b.id}) ORDER BY ${q("id")}`,
      );
      expect(
        rows.map((r) => ({
          id: Number(r.id),
          code: r.code,
          meta: typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta,
          status: r.status,
          slug: r.slug,
        })),
      ).toEqual([
        { id: a.id, code: "code:x1", meta: { tags: ["red"] }, status: "draft", slug: "slug-a" },
        { id: b.id, code: "code:x2", meta: { tags: [] }, status: "live", slug: "slug-b" },
      ]);
      expect([a.status, a.slug]).toEqual(["draft", "slug-a"]);
    });
  },
);

describe.each(getTestDrivers())(
  "[Integration] $label: WriteBuffer batchInsert under tenant_column",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Note: any;
    const table = `bbip_note_${suffix}`;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false, tenantStrategy: "tenant_column", plugins: [bufferPlugin()] },
        () => {
          @Entity({ name: table })
          class TenantNote {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) body!: string;
          }
          Note = TenantNote;
          return { entities: [TenantNote] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      MetadataContext.reset();
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("writes the current tenant on every row", async () => {
      await MetadataContext.run("acme", async () => {
        const buf: WriteBuffer = (em as any).buffer({ batchInsert: true });
        buf.persist(Object.assign(new Note(), { body: "one" })).persist(Object.assign(new Note(), { body: "two" }));
        await buf.flush();
      });

      const read = (tenant: string) =>
        MetadataContext.run(tenant, () => em.find(Note, { orderBy: { id: "ASC" } }));
      expect((await read("acme")).map((n: any) => n.body)).toEqual(["one", "two"]);
      expect(await read("globex")).toEqual([]);
    });
  },
);
