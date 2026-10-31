/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `attachRelation()` / `detachRelation()` under `tenant_column` on real
 * servers (MySQL/MariaDB + PostgreSQL): both writes check the two ids against
 * the active tenant before touching the join table, which has no tenant
 * column of its own.
 *
 * SQLite mirror: __tests__/integration/sqlite/m2m-attach-tenant-scope.test.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryGeneratedColumn, ManyToMany } from "../../src";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { EntityNotFoundError } from "../../src/errors/EntityNotFoundError";
import {
  createTestConnection,
  dropTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const drivers = getTestDrivers();

const TABLES = { pivot: "matd_post_tag", post: "matd_post", tag: "matd_tag" };

describe.each(drivers)(
  "[Integration] $label: M2M attach/detach under tenant_column",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Post: any;
    let Tag: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false, tenantStrategy: "tenant_column" },
        () => {
          @Entity({ name: TABLES.tag })
          class MatdTag {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
          }
          @Entity({ name: TABLES.post })
          class MatdPost {
            @PrimaryGeneratedColumn() id!: number;
            @Column() title!: string;
            @ManyToMany(() => MatdTag, {
              joinTable: { name: TABLES.pivot, joinColumn: "post_id", inverseJoinColumn: "tag_id" },
            })
            tags!: MatdTag[];
          }
          Post = MatdPost;
          Tag = MatdTag;
          return { entities: [MatdPost, MatdTag] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      for (const table of Object.values(TABLES)) {
        try {
          await dropTestTable(table);
        } catch {
          // ignore
        }
      }
      await conn.cleanup();
    }, 15000);

    const acme = <R>(fn: () => Promise<R>) => MetadataContext.run("acme", fn);
    const globex = <R>(fn: () => Promise<R>) => MetadataContext.run("globex", fn);

    it("keeps another tenant's rows out of both writes", async () => {
      MetadataContext.reset();
      const globexPost: any = await globex(() => em.save(Post, { title: "g" }));
      const globexTag: any = await globex(() => em.save(Tag, { name: "g" }));
      await globex(() => em.attachRelation(Post, globexPost.id, "tags", globexTag.id));
      const acmeTag: any = await acme(() => em.save(Tag, { name: "a" }));

      let error: unknown;
      try {
        await acme(() => em.attachRelation(Post, globexPost.id, "tags", acmeTag.id));
      } catch (e) {
        error = e;
      }
      const detached = await acme(() =>
        em.detachRelation(Post, globexPost.id, "tags", globexTag.id),
      );
      const post: any = await globex(() =>
        em.findOne(Post, { where: { id: globexPost.id }, relations: ["tags"] } as any),
      );

      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(detached).toEqual({ affected: 0 });
      expect(post.tags.map((tag: any) => tag.name)).toEqual(["g"]);
    });

    it("links and unlinks the active tenant's rows", async () => {
      MetadataContext.reset();
      const post: any = await acme(() => em.save(Post, { title: "a2" }));
      const tag: any = await acme(() => em.save(Tag, { name: "a2" }));

      const attached = await acme(() => em.attachRelation(Post, post.id, "tags", tag.id));
      const detached = await acme(() => em.detachRelation(Post, post.id, "tags", tag.id));

      expect(attached).toEqual({ affected: 1 });
      expect(detached).toEqual({ affected: 1 });
    });
  },
);
