/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToMany } from "../../src/decorators/OneToMany";
import { ManyToMany } from "../../src/decorators/ManyToMany";
import { OneToOne } from "../../src/decorators/OneToOne";
import { NonTenantEntity } from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";

/**
 * Phase 6 — RelationLoader tenant predicate propagation. Verifies that
 * batched sub-queries for OneToMany, ManyToMany and inverse OneToOne loads
 * never leak rows belonging to another tenant, and that JOINs for eager
 * ManyToOne still honor the tenant scope on the owning (main) table.
 */
describe("RelationLoader under tenant_column strategy", () => {
  async function makeEm(entities: any[], opts: Record<string, any> = {}) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities,
        synchronize: true,
        tenantStrategy: "tenant_column",
        ...opts,
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    return em;
  }

  beforeEach(() => MetadataContext.reset());

  // ── OneToMany ────────────────────────────────────────────────────────

  describe("OneToMany batched load", () => {
    @Entity()
    class Author {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @OneToMany(() => Book, { mappedBy: "author" }) books!: Book[];
    }

    @Entity()
    class Book {
      @PrimaryGeneratedColumn() id!: number;
      @Column() title!: string;
      @Column({ type: "int", nullable: true }) authorId!: number | null;
      @ManyToOne(() => Author, (a: any) => a.books, {
        joinColumn: "authorId",
        createForeignKeyConstraints: false,
      })
      author!: Author;
    }

    it("loads only the current tenant's children", async () => {
      const em = await makeEm([Author, Book]);
      try {
        let acmeAuthorId!: number;
        let globexAuthorId!: number;
        await MetadataContext.run("acme", async () => {
          const a: any = await em.save(Author, { name: "Alice" });
          acmeAuthorId = a.id;
          await em.save(Book, { title: "A-book", authorId: acmeAuthorId });
          await em.save(Book, { title: "A-book-2", authorId: acmeAuthorId });
        });
        await MetadataContext.run("globex", async () => {
          const g: any = await em.save(Author, { name: "Bob" });
          globexAuthorId = g.id;
          await em.save(Book, { title: "B-book", authorId: globexAuthorId });
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(Author, {
            where: { name: "Alice" } as any,
            relations: ["books"] as any,
          });
          expect(rows.length).toBe(1);
          expect(rows[0].books.length).toBe(2);
          const titles = rows[0].books.map((b: any) => b.title).sort();
          expect(titles).toEqual(["A-book", "A-book-2"]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("cross-tenant leak test — A's parent cannot see B's children via the FK space", async () => {
      // Under SQLite, autoIncrement IDs start at 1 per table regardless of
      // tenant. If RelationLoader naively issues `WHERE authorId IN (ids)`
      // without tenant scoping, a tenant A Author with id=1 could see tenant
      // B's Book whose authorId is also 1. The predicate guards against this.
      const em = await makeEm([Author, Book]);
      try {
        await MetadataContext.run("acme", async () => {
          await em.save(Author, { name: "AcmeAuthor" });
          // tenant A has author.id=1 but no books yet
        });
        await MetadataContext.run("globex", async () => {
          const g: any = await em.save(Author, { name: "GlobexAuthor" });
          await em.save(Book, { title: "B-book", authorId: g.id });
        });

        // Under acme, loading the Author's books must return an empty list —
        // NOT the globex book even though the FK happens to match.
        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(Author, {
            relations: ["books"] as any,
          });
          expect(rows.length).toBe(1);
          expect(rows[0].books).toEqual([]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── ManyToMany ───────────────────────────────────────────────────────

  // NOTE: SQLite's DDL limitations (no ALTER TABLE ADD FOREIGN KEY; M2M join
  // table is created without `createForeignKeyConstraints: false` support)
  // make this suite unreliable here. Phase 8 integration tests (MySQL/PG)
  // cover ManyToMany tenant-scoping end-to-end.
  xdescribe("ManyToMany batched load", () => {
    @Entity()
    class Post {
      @PrimaryGeneratedColumn() id!: number;
      @Column() title!: string;
      @ManyToMany(() => Tag, {
        joinTable: {
          name: "post_tags",
          joinColumn: "postId",
          inverseJoinColumn: "tagId",
        },
      })
      tags!: Tag[];
    }

    @Entity()
    class Tag {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
      @ManyToMany(() => Post, { mappedBy: "tags" }) posts!: Post[];
    }

    it("only the current tenant's tags are loaded", async () => {
      const em = await makeEm([Post, Tag]);
      try {
        await MetadataContext.run("acme", async () => {
          const p: any = await em.save(Post, { title: "acme-post" });
          const t1: any = await em.save(Tag, { name: "acme-tag-1" });
          const t2: any = await em.save(Tag, { name: "acme-tag-2" });
          // manually insert into the join table for both acme rows
          await em.query(
            "INSERT INTO post_tags (postId, tagId, tenant_id) VALUES (?, ?, ?), (?, ?, ?)",
            [p.id, t1.id, "acme", p.id, t2.id, "acme"],
          );
        });
        await MetadataContext.run("globex", async () => {
          const p: any = await em.save(Post, { title: "globex-post" });
          const t: any = await em.save(Tag, { name: "globex-tag" });
          await em.query(
            "INSERT INTO post_tags (postId, tagId, tenant_id) VALUES (?, ?, ?)",
            [p.id, t.id, "globex"],
          );
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(Post, {
            relations: ["tags"] as any,
          });
          expect(rows.length).toBe(1);
          const names = rows[0].tags.map((t: any) => t.name).sort();
          expect(names).toEqual(["acme-tag-1", "acme-tag-2"]);
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── OneToOne inverse ─────────────────────────────────────────────────

  // OneToOne FK creation in SchemaRegistrar now honors
  // `createForeignKeyConstraints: false`, so the owning Profile entity below
  // declares its `accountId` column explicitly and no ALTER TABLE ADD FOREIGN
  // KEY is attempted — which lets this run under SQLite. Phase 8 MySQL/PG
  // integration tests still cover inverse OneToOne tenant-scoping with real FKs.
  describe("OneToOne (inverse) batched load", () => {
    @Entity()
    class Account {
      @PrimaryGeneratedColumn() id!: number;
      @Column() handle!: string;
      // Deliberately typed `any` so the emitted design:type metadata does
      // not resolve to a class not yet declared (Profile below).
      @OneToOne(() => Profile, { inverseSide: "account" })
      profile!: any;
    }

    @Entity()
    class Profile {
      @PrimaryGeneratedColumn() id!: number;
      @Column() bio!: string;
      @Column({ type: "int", nullable: true }) accountId!: number | null;
      @OneToOne(() => Account, {
        joinColumn: "accountId",
        createForeignKeyConstraints: false,
      })
      account!: Account;
    }

    it("only the current tenant's profile is returned", async () => {
      const em = await makeEm([Account, Profile]);
      try {
        await MetadataContext.run("acme", async () => {
          const a: any = await em.save(Account, { handle: "@acme" });
          await em.save(Profile, { bio: "acme-bio", accountId: a.id });
        });
        await MetadataContext.run("globex", async () => {
          const a: any = await em.save(Account, { handle: "@globex" });
          await em.save(Profile, {
            bio: "globex-bio",
            accountId: a.id,
          });
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(Account, {
            relations: ["profile"] as any,
          });
          expect(rows.length).toBe(1);
          expect(rows[0].profile?.bio).toBe("acme-bio");
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── @NonTenantEntity child — predicate is skipped ────────────────────

  describe("@NonTenantEntity relation target", () => {
    @NonTenantEntity()
    @Entity()
    class Currency {
      @PrimaryGeneratedColumn() id!: number;
      @Column() code!: string;
    }

    @Entity()
    class Invoice {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "int" }) amount!: number;
      @Column({ type: "int", nullable: true }) currencyId!: number | null;
      @ManyToOne(() => Currency, () => undefined, {
        joinColumn: "currencyId",
        eager: true,
        createForeignKeyConstraints: false,
      })
      currency!: Currency;
    }

    it("M2O eager JOIN to a @NonTenantEntity does not add a tenant predicate on the child", async () => {
      // Currency has no tenant_id column, so the child-table predicate must
      // be skipped; only the owning Invoice is tenant-scoped. A missing skip
      // would produce `currency.tenant_id = ?` and throw at query time.
      const em = await makeEm([Currency, Invoice]);
      try {
        // Currency is global — seed without a tenant context.
        await em.save(Currency, { code: "USD" });
        await em.save(Currency, { code: "EUR" });

        await MetadataContext.run("acme", async () => {
          const all: any[] = await em.find(Currency);
          const usd = all.find((c) => c.code === "USD");
          await em.save(Invoice, { amount: 100, currencyId: usd!.id });
        });

        await MetadataContext.run("acme", async () => {
          const rows: any[] = await em.find(Invoice);
          expect(rows.length).toBe(1);
          expect(rows[0].currency?.code).toBe("USD");
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });
});
