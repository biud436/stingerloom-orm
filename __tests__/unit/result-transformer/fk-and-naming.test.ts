/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Expose } from "class-transformer";
import {
  Column,
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
} from "../../../src/decorators";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { ResultTransformerFactory } from "../../../src/core";
import type { QueryResult } from "../../../src/types";

/**
 * Regression suite — `ResultTransformer` FK / NamingStrategy hydration.
 *
 * Hydration is the trust boundary of the ORM. Bugs here surface as
 * wrong-shaped objects in API responses. Each named test below pins a
 * historical fix or a high-risk edge case so a renderer change cannot
 * silently break the read path.
 *
 * The tests drive the transformer directly with synthetic driver rows —
 * no DB connection required.
 */

const rt = ResultTransformerFactory.create();

describe("ResultTransformer / FK + NamingStrategy regression", () => {
  /**
   * Regression for `6ad3b5a` — when an entity declared a custom `fkProperty`
   * (e.g. `sourceIssueId` for `source: Issue`), the transformer's FK column
   * remap was hard-coded to the conventional `${rel}Id` shadow and the raw
   * `source_id` DB column leaked through unchanged.
   */
  describe("@ManyToOne — fkProperty override (commit 6ad3b5a)", () => {
    @Entity()
    class Workspace {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;
    }

    @Entity()
    class Member {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @ManyToOne(() => Workspace, undefined as any, { fkProperty: "wsId" })
      @RelationColumn({ name: "workspace_id" })
      workspace?: Workspace;

      @Expose()
      @Column({ type: "int", name: "workspace_id" })
      wsId!: number;
    }

    it("maps DB `workspace_id` to custom fkProperty `wsId`, not `workspaceId`", () => {
      const result: QueryResult = {
        results: [{ id: 7, workspace_id: 42 }],
      };
      const m = rt.toEntity(Member, result) as Member;
      expect(m).toBeInstanceOf(Member);
      expect(m.id).toBe(7);
      expect((m as any).wsId).toBe(42);
      // The conventional shadow must NOT be populated when fkProperty
      // overrides it — otherwise hydration would invent a property the
      // entity never declared.
      expect((m as any).workspaceId).toBeUndefined();
      // And the raw DB column name must not leak.
      expect((m as any).workspace_id).toBeUndefined();
    });
  });

  describe("@ManyToOne — default `{rel}Id` shadow", () => {
    @Entity()
    class Author {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;
    }

    @Entity()
    class Post {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @ManyToOne(() => Author, undefined as any)
      @RelationColumn({ name: "author_id" })
      author?: Author;

      @Expose()
      @Column({ type: "int", name: "author_id" })
      authorId!: number;
    }

    it("maps DB `author_id` to the conventional `authorId` shadow", () => {
      const result: QueryResult = {
        results: [{ id: 1, author_id: 100 }],
      };
      const p = rt.toEntity(Post, result) as Post;
      expect(p.id).toBe(1);
      expect(p.authorId).toBe(100);
      expect((p as any).author_id).toBeUndefined();
    });

    it("passes through `null` FK values without coercion to 0/undefined", () => {
      const result: QueryResult = {
        results: [{ id: 2, author_id: null }],
      };
      const p = rt.toEntity(Post, result) as Post;
      expect(p.id).toBe(2);
      // `null` must remain `null` — coercion to undefined would make
      // "no FK" indistinguishable from "FK not selected".
      expect(p.authorId).toBeNull();
    });
  });

  describe("NamingStrategy round-trip — snake_case `@Column({ name })`", () => {
    @Entity()
    class Article {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "varchar", name: "full_title" })
      fullTitle!: string;

      @Expose()
      @Column({ type: "datetime", name: "created_at" })
      createdAt!: Date;

      @Expose()
      @Column({ type: "varchar", name: "published_at" })
      publishedAt!: string;
    }

    it("remaps every snake_case DB column back to its camelCase property", () => {
      const result: QueryResult = {
        results: [
          {
            id: 1,
            full_title: "Hello",
            created_at: "2026-04-09T00:00:00Z",
            published_at: "2026-04-10T00:00:00Z",
          },
        ],
      };
      const a = rt.toEntity(Article, result) as Article;
      expect(a.id).toBe(1);
      expect(a.fullTitle).toBe("Hello");
      expect(a.publishedAt).toBe("2026-04-10T00:00:00Z");
      // The raw snake_case keys must not survive on the hydrated entity.
      expect((a as any).full_title).toBeUndefined();
      expect((a as any).created_at).toBeUndefined();
      expect((a as any).published_at).toBeUndefined();
    });

    it("preserves remap across the toEntities batch path", () => {
      const result: QueryResult = {
        results: [
          { id: 1, full_title: "A", created_at: "2026-01-01", published_at: "2026-01-02" },
          { id: 2, full_title: "B", created_at: "2026-01-03", published_at: "2026-01-04" },
        ],
      };
      const rows = rt.toEntities(Article, result);
      expect(rows).toHaveLength(2);
      expect(rows[0].fullTitle).toBe("A");
      expect(rows[1].fullTitle).toBe("B");
      expect((rows[0] as any).full_title).toBeUndefined();
    });
  });

  describe("@OneToOne — fkProperty override on owning side", () => {
    @Entity()
    class Profile {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;
    }

    @Entity()
    class UserAccount {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @OneToOne(() => Profile, {
        joinColumn: "profile_pk",
        fkProperty: "profilePk",
      })
      @RelationColumn({ name: "profile_pk" })
      profile?: Profile;

      @Expose()
      @Column({ type: "int", name: "profile_pk" })
      profilePk!: number;
    }

    it("maps DB `profile_pk` to the OneToOne fkProperty override", () => {
      const result: QueryResult = {
        results: [{ id: 1, profile_pk: 99 }],
      };
      const u = rt.toEntity(UserAccount, result) as UserAccount;
      expect(u.id).toBe(1);
      expect(u.profilePk).toBe(99);
      expect((u as any).profile_pk).toBeUndefined();
    });
  });

  describe("@RelationColumn — `@Column` explicit remap takes precedence", () => {
    /**
     * When both `@Column({ name })` and `@RelationColumn({ name })` reference
     * the same DB column, the `@Column` remap wins so the explicit property
     * name the user declared on the column is preserved. Verifies the
     * "Don't clobber an explicit @Column remap entry" branch in
     * `getCachedColumnInfo`.
     */
    @Entity()
    class Org {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;
    }

    @Entity()
    class Employee {
      @Expose()
      @PrimaryColumn({ type: "int", name: "id" })
      id!: number;

      @Expose()
      @Column({ type: "int", name: "org_id" })
      orgRef!: number;

      @Expose()
      @ManyToOne(() => Org, undefined as any)
      @RelationColumn({ name: "org_id" })
      org?: Org;
    }

    it("DB `org_id` maps to the @Column-declared `orgRef`, not the inferred `orgId`", () => {
      const result: QueryResult = {
        results: [{ id: 1, org_id: 5 }],
      };
      const e = rt.toEntity(Employee, result) as Employee;
      expect(e.id).toBe(1);
      expect(e.orgRef).toBe(5);
      expect((e as any).orgId).toBeUndefined();
    });
  });
});
