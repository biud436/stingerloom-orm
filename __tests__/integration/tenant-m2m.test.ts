/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenant_column strategy × ManyToMany batched load on real MySQL/PostgreSQL.
 *
 * The SQLite suite (__tests__/unit/tenant-column-relations.test.ts,
 * "ManyToMany batched load") spent years as an xdescribe whose note claimed
 * "Phase 8 integration tests (MySQL/PG) cover ManyToMany tenant-scoping
 * end-to-end" — no such coverage existed anywhere. This file is that
 * missing mirror, with the real join-table DDL (FK constraints included)
 * the in-memory suite cannot exercise.
 *
 * Shipped design under test: the M2M join table carries NO tenant column.
 * Isolation holds because every tenant shares one table (PKs are globally
 * unique, so a tenant's pivot rows can only reference that tenant's owner
 * rows) and because the batched load applies the tenant predicate to the
 * RELATED table, which also filters adversarial cross-tenant pivot rows.
 *
 * Runs only under INTEGRATION_TEST=true.
 */

import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToMany } from "../../src/decorators/ManyToMany";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import {
  createTestConnection,
  dropTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const TABLES = {
  post: "tm2m_post",
  tag: "tm2m_tag",
  pivot: "tm2m_post_tags",
} as const;

describe.each(drivers)(
  "[Integration][$label] tenant_column × ManyToMany batched load",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let PostE: any;
    let TagE: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          tenantStrategy: "tenant_column",
        },
        () => {
          @Entity({ name: TABLES.post })
          class Post {
            @PrimaryGeneratedColumn() id!: number;
            @Column() title!: string;
            @ManyToMany(() => Tag, {
              joinTable: {
                name: TABLES.pivot,
                joinColumn: "postId",
                inverseJoinColumn: "tagId",
              },
            })
            tags!: Tag[];
          }

          @Entity({ name: TABLES.tag })
          class Tag {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
            @ManyToMany(() => Post, { mappedBy: "tags" }) posts!: Post[];
          }

          PostE = Post;
          TagE = Tag;
          return { entities: [Post, Tag] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      // Drop the FK-bearing pivot first, then the referenced tables.
      for (const t of [TABLES.pivot, TABLES.post, TABLES.tag]) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    }, 30000);

    beforeEach(async () => {
      MetadataContext.reset();
      // DELETE (not TRUNCATE) — the pivot's FK constraints block TRUNCATE
      // on the referenced tables in MySQL.
      for (const t of [TABLES.pivot, TABLES.post, TABLES.tag]) {
        await em.query(`DELETE FROM ${t}`);
      }
    });

    it("join table DDL — 피벗 테이블이 테넌트 컬럼 없이 생성된다", async () => {
      const driver = em.getDriver()!;
      expect(await driver.hasColumn(TABLES.pivot, "postId")).toBe(true);
      expect(await driver.hasColumn(TABLES.pivot, "tagId")).toBe(true);
      expect(await driver.hasColumn(TABLES.pivot, "tenant_id")).toBe(false);
    });

    it("배치 로드 — 현재 테넌트의 태그만 로드된다", async () => {
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(PostE, { title: "acme-post" });
        const t1: any = await em.save(TagE, { name: "acme-tag-1" });
        const t2: any = await em.save(TagE, { name: "acme-tag-2" });
        await em.attachRelation(PostE, p.id, "tags", t1.id);
        await em.attachRelation(PostE, p.id, "tags", t2.id);
      });
      await MetadataContext.run("globex", async () => {
        const p: any = await em.save(PostE, { title: "globex-post" });
        const t: any = await em.save(TagE, { name: "globex-tag" });
        await em.attachRelation(PostE, p.id, "tags", t.id);
      });

      await MetadataContext.run("acme", async () => {
        const rows: any[] = await em.find(PostE, { relations: ["tags"] as any });
        expect(rows.length).toBe(1);
        expect(rows[0].tags.map((t: any) => t.name).sort()).toEqual([
          "acme-tag-1",
          "acme-tag-2",
        ]);
      });
      await MetadataContext.run("globex", async () => {
        const rows: any[] = await em.find(PostE, { relations: ["tags"] as any });
        expect(rows.length).toBe(1);
        expect(rows[0].tags.map((t: any) => t.name)).toEqual(["globex-tag"]);
      });
    });

    it("적대적 교차 테넌트 피벗 행 — 상대 테넌트의 태그가 유출되지 않는다", async () => {
      let acmePostId!: number;
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(PostE, { title: "acme-post" });
        acmePostId = p.id;
      });
      let globexTagId!: number;
      await MetadataContext.run("globex", async () => {
        const t: any = await em.save(TagE, { name: "globex-secret" });
        globexTagId = t.id;
      });

      await MetadataContext.run("acme", async () => {
        // attachRelation does not validate tenant ownership of the related
        // row — representable bad data the read path must still contain.
        await em.attachRelation(PostE, acmePostId, "tags", globexTagId);

        const rows: any[] = await em.find(PostE, { relations: ["tags"] as any });
        expect(rows.length).toBe(1);
        expect(rows[0].tags).toEqual([]);
      });
    });

    it("detachRelation — 분리 후 배치 로드에서 사라진다", async () => {
      await MetadataContext.run("acme", async () => {
        const p: any = await em.save(PostE, { title: "acme-post" });
        const t1: any = await em.save(TagE, { name: "keep" });
        const t2: any = await em.save(TagE, { name: "drop" });
        await em.attachRelation(PostE, p.id, "tags", t1.id);
        await em.attachRelation(PostE, p.id, "tags", t2.id);

        await em.detachRelation(PostE, p.id, "tags", t2.id);

        const rows: any[] = await em.find(PostE, { relations: ["tags"] as any });
        expect(rows[0].tags.map((t: any) => t.name)).toEqual(["keep"]);
      });
    });
  },
);
