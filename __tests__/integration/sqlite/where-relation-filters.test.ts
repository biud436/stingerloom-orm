/**
 * Relation filters in `where`: rows filtered by their related rows.
 *
 * - Collections (`@OneToMany`, `@ManyToMany`): `some` / `none` / `every`.
 * - Single-valued (`@ManyToOne`, both `@OneToOne` sides): `is` / `isNot`,
 *   `null` for "has none" / "has one".
 * - Each compiles to a correlated `EXISTS`, scoped like a relation load
 *   (soft-delete unless `withDeleted`, tenant, single-table subtype), and
 *   nests: a filter's where can filter the related entity's relations.
 * - find / findOne / findAndCount / count / exists / findWithCursor agree,
 *   a relation's own `where` in `relations` takes them too, and write
 *   criteria reject them with a dedicated message.
 *
 * PG / MariaDB: __tests__/integration/where-relation-filters.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "wrf_users" })
class WrfUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => WrfPost, { mappedBy: "author" }) posts!: WrfPost[];
  @OneToOne(() => WrfProfile, { inverseSide: "owner" }) profile!: Relation<WrfProfile> | null;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "wrf_profiles" })
class WrfProfile {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) bio!: string;
  @OneToOne(() => WrfUser)
  @RelationColumn({ name: "owner_id" })
  owner!: Relation<WrfUser>;
}

@Entity({ name: "wrf_tags" })
class WrfTag {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
}

@Entity({ name: "wrf_posts" })
class WrfPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => WrfUser, (u: WrfUser) => u.posts)
  @RelationColumn({ name: "author_id", nullable: true })
  author!: Relation<WrfUser> | null;
  @OneToMany(() => WrfComment, { mappedBy: "post" }) comments!: WrfComment[];
  @ManyToMany(() => WrfTag, {
    joinTable: { name: "wrf_post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags!: WrfTag[];
}

@Entity({ name: "wrf_comments" })
class WrfComment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) body!: string;
  @Column({ type: "boolean" }) approved!: boolean;
  @Column({ type: "int", nullable: true }) score!: number | null;
  @ManyToOne(() => WrfPost, (p: WrfPost) => p.comments)
  @RelationColumn({ name: "post_id" })
  post!: Relation<WrfPost>;
  @ManyToOne(() => WrfUser, (u: WrfUser) => u.id)
  @RelationColumn({ name: "author_id" })
  author!: Relation<WrfUser>;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "wrf_categories" })
class WrfCategory {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @ManyToOne(() => WrfCategory, (c: WrfCategory) => c.children)
  @RelationColumn({ name: "parent_id", nullable: true })
  parent!: Relation<WrfCategory> | null;
  @OneToMany(() => WrfCategory, { mappedBy: "parent" }) children!: WrfCategory[];
}

// A OneToOne with no owning column on either side: nothing correlates the
// two rows. register() refuses the pair; an attach()ed EntityManager skips
// that check, and a filter on it is refused instead of binding the filter
// object as a column value.
@Entity({ name: "wrf_lockers" })
class WrfLocker {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => WrfKey, { inverseSide: "locker" }) key!: Relation<WrfKey> | null;
}

@Entity({ name: "wrf_keys" })
class WrfKey {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => WrfLocker) locker!: Relation<WrfLocker> | null;
}

describe("[Integration] SQLite: relation filters in where", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [WrfUser, WrfProfile, WrfTag, WrfPost, WrfComment, WrfCategory],
    });
    const alice = await em.save(WrfUser, { name: "alice" });
    const bob = await em.save(WrfUser, { name: "bob" });
    const gone = await em.save(WrfUser, { name: "gone" });
    await em.save(WrfProfile, { bio: "alice's", owner: alice });
    const orm = await em.save(WrfTag, { label: "orm" });
    const sql = await em.save(WrfTag, { label: "sql" });

    // p1 (alice): approved by bob + pending by alice, tags orm+sql
    // p2 (bob):   one approved comment by alice, tag sql
    // p3 (none):  no comments, no tags
    // p4 (gone):  one trashed comment only; author soft-deleted
    const p1 = await em.save(WrfPost, { title: "p1", author: alice });
    const p2 = await em.save(WrfPost, { title: "p2", author: bob });
    await em.save(WrfPost, { title: "p3", author: null });
    const p4 = await em.save(WrfPost, { title: "p4", author: gone });
    await em.query(
      `INSERT INTO wrf_post_tags (post_id, tag_id) VALUES (${p1.id}, ${orm.id}), (${p1.id}, ${sql.id}), (${p2.id}, ${sql.id})`,
    );
    await em.save(WrfComment, { body: "nice", approved: true, score: 5, post: p1, author: bob });
    await em.save(WrfComment, { body: "hmm", approved: false, score: 3, post: p1, author: alice });
    await em.save(WrfComment, { body: "ok", approved: true, score: null, post: p2, author: alice });
    const trashed = await em.save(WrfComment, { body: "spam", approved: false, post: p4, author: bob });
    await em.softDelete(WrfComment, { id: trashed.id });
    await em.softDelete(WrfUser, { id: gone.id });

    const root = await em.save(WrfCategory, { name: "root", parent: null });
    const child = await em.save(WrfCategory, { name: "child", parent: root });
    await em.save(WrfCategory, { name: "leaf", parent: child });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const titles = async (where: any, extra: Record<string, unknown> = {}) =>
    (await em.find(WrfPost, { where, orderBy: { id: "ASC" }, ...extra })).map((p) => p.title);

  describe("collections", () => {
    it("some / none / every on a OneToMany", async () => {
      expect(await titles({ comments: { some: { approved: true } } })).toEqual(["p1", "p2"]);
      expect(await titles({ comments: { none: { approved: false } } })).toEqual(["p2", "p3", "p4"]);
      expect(await titles({ comments: { every: { approved: true } } })).toEqual(["p2", "p3", "p4"]);
    });

    it("every counts a related row its where cannot decide (NULL) as failing", async () => {
      // p1: scores 5 and 3 — every row passes. p2: one comment with a NULL
      // score — NOT (score > 0) is unknown for it, and it still counts
      // against the post. p3 / p4: no live comment — vacuously true.
      expect(await titles({ comments: { every: { score: { gt: 0 } } } })).toEqual(["p1", "p3", "p4"]);
      expect(await titles({ comments: { every: { score: null } } })).toEqual(["p2", "p3", "p4"]);
    });

    it("some: {} has any, none: {} has none, every: {} is always true", async () => {
      expect(await titles({ comments: { some: {} } })).toEqual(["p1", "p2"]);
      expect(await titles({ comments: { none: {} } })).toEqual(["p3", "p4"]);
      expect(await titles({ comments: { every: {} } })).toEqual(["p1", "p2", "p3", "p4"]);
    });

    it("a ManyToMany reads through its join table", async () => {
      expect(await titles({ tags: { some: { label: "orm" } } })).toEqual(["p1"]);
      expect(await titles({ tags: { none: {} } })).toEqual(["p3", "p4"]);
      expect(await titles({ tags: { every: { label: "sql" } } })).toEqual(["p2", "p3", "p4"]);
    });

    it("ORs an array, combines with columns, AND / OR / NOT", async () => {
      expect(await titles({ comments: { some: [{ body: "ok" }, { body: "hmm" }] } })).toEqual(["p1", "p2"]);
      expect(await titles({ title: { ne: "p1" }, comments: { some: {} } })).toEqual(["p2"]);
      expect(
        await titles({ OR: [{ tags: { some: { label: "orm" } } }, { comments: { none: {} } }] }),
      ).toEqual(["p1", "p3", "p4"]);
      expect(await titles({ NOT: { comments: { some: {} } } })).toEqual(["p3", "p4"]);
    });
  });

  describe("single-valued relations", () => {
    it("is / isNot / null on a ManyToOne", async () => {
      expect(await titles({ author: { is: { name: "alice" } } })).toEqual(["p1"]);
      expect(await titles({ author: { isNot: { name: "alice" } } })).toEqual(["p2", "p3", "p4"]);
      // p4's author is soft-deleted: it reads as no author, as a relation load reads it.
      expect(await titles({ author: { is: null } })).toEqual(["p3", "p4"]);
      expect(await titles({ author: { isNot: null } })).toEqual(["p1", "p2"]);
      expect(await titles({ author: { is: null } }, { withDeleted: true })).toEqual(["p3"]);
    });

    it("is on both sides of a OneToOne", async () => {
      const owners = await em.find(WrfUser, { where: { profile: { is: { bio: "alice's" } } } });
      expect(owners.map((u) => u.name)).toEqual(["alice"]);
      const without = await em.find(WrfUser, { where: { profile: { is: null } }, orderBy: { id: "ASC" } });
      expect(without.map((u) => u.name)).toEqual(["bob"]);
      const profiles = await em.find(WrfProfile, { where: { owner: { is: { name: "alice" } } } });
      expect(profiles.map((p) => p.bio)).toEqual(["alice's"]);
    });
  });

  describe("nesting and scope", () => {
    it("filters a related entity's relations, to any depth", async () => {
      expect(
        await titles({ comments: { some: { author: { is: { name: "alice" } } } } }),
      ).toEqual(["p1", "p2"]);
      const authors = await em.find(WrfUser, {
        where: { posts: { some: { comments: { some: { author: { is: { name: "bob" } }, approved: true } } } } },
      });
      expect(authors.map((u) => u.name)).toEqual(["alice"]);
    });

    it("ignores soft-deleted related rows unless the read asks for them", async () => {
      expect(await titles({ comments: { some: { body: "spam" } } })).toEqual([]);
      expect(await titles({ comments: { some: { body: "spam" } } }, { withDeleted: true })).toEqual(["p4"]);
    });

    it("correlates a self-referencing relation with the outer row", async () => {
      const withChildren = await em.find(WrfCategory, {
        where: { children: { some: {} } },
        orderBy: { id: "ASC" },
      });
      expect(withChildren.map((c) => c.name)).toEqual(["root", "child"]);
      const underRoot = await em.find(WrfCategory, { where: { parent: { is: { name: "root" } } } });
      expect(underRoot.map((c) => c.name)).toEqual(["child"]);
    });
  });

  describe("every read path agrees", () => {
    const where = { comments: { some: { approved: true } } } as const;

    it("findOne, findAndCount, count, exists and findWithCursor", async () => {
      expect((await em.findOne(WrfPost, { where: { ...where, title: "p2" } }))?.title).toBe("p2");
      const [rows, total] = await em.findAndCount(WrfPost, { where, take: 1, orderBy: { id: "ASC" } });
      expect([rows.map((p) => p.title), total]).toEqual([["p1"], 2]);
      expect(await em.count(WrfPost, where)).toBe(2);
      expect(await em.exists(WrfPost, { comments: { some: { body: "spam" } } })).toBe(false);
      const page = await em.findWithCursor(WrfPost, { where, take: 10 });
      expect(page.data.map((p) => p.title)).toEqual(["p1", "p2"]);
    });

    it("works in a relation's own where and with JOINed relations", async () => {
      const users = await em.find(WrfUser, {
        where: { name: "alice" },
        relations: { posts: { where: { comments: { some: { approved: false } } } } },
      });
      expect(users[0].posts.map((p) => p.title)).toEqual(["p1"]);

      const joined = await em.find(WrfPost, {
        where: { author: { is: { name: "bob" } } },
        relations: ["author"],
      });
      expect(joined.map((p) => [p.title, p.author?.name])).toEqual([["p2", "bob"]]);
    });
  });

  describe("query cache", () => {
    it("a cached read is invalidated by a write to a table its relation filter reads", async () => {
      const cache = em.queryCache!;
      await cache.clear();
      const option = { where: { comments: { some: { body: "fresh" } } }, cache: true } as const;

      expect(await em.find(WrfPost, option)).toEqual([]);
      const hitsBefore = cache.stats.hits;
      await em.find(WrfPost, option);
      expect(cache.stats.hits).toBe(hitsBefore + 1);

      // No post row changes, only a comment row — the comments table is
      // read by the filter's EXISTS, so the entry must fall with the write.
      const p3 = (await em.findOne(WrfPost, { where: { title: "p3" } }))!;
      const alice = (await em.findOne(WrfUser, { where: { name: "alice" } }))!;
      const fresh = await em.save(WrfComment, { body: "fresh", approved: true, score: 1, post: p3, author: alice });
      try {
        expect((await em.find(WrfPost, option)).map((p) => p.title)).toEqual(["p3"]);
      } finally {
        await em.delete(WrfComment, { id: fresh.id });
        await cache.clear();
      }
    });
  });

  describe("validation", () => {
    it("rejects a filter on the inverse side of a OneToOne whose owner has no join column", async () => {
      await expect(
        createTestEntityManager({ entities: [WrfLocker, WrfKey], connectionName: "wrf_locker" }),
      ).rejects.toThrow(/WrfLocker\.key: @OneToOne inverseSide "locker" names WrfKey\.locker, which holds no join column either/);

      const attached = new EntityManager();
      await attached.attach("test", { entities: [WrfLocker, WrfKey] });
      await expect(
        attached.find(WrfLocker, { where: { key: { is: { id: 1 } } } }),
      ).rejects.toThrow(/cannot be filtered: it is the inverse side of a OneToOne and "locker" on "WrfKey" holds no join column/);
    });

    it("rejects a filter key that does not fit the relation", async () => {
      await expect(titles({ author: { some: {} } })).rejects.toThrow(
        /"some" cannot filter relation "author" of "WrfPost": it is a ManyToOne, which takes "is" \/ "isNot"/,
      );
      await expect(titles({ comments: { is: {} } })).rejects.toThrow(/it is a OneToMany/);
      await expect(titles({ comments: { some: null } })).rejects.toThrow(/a collection filter takes a where clause/);
    });

    it("checks a filter's columns against the related entity before running", async () => {
      await expect(titles({ comments: { some: { bodyy: "x" } } })).rejects.toThrow(InvalidQueryError);
      await expect(titles({ comments: { some: { bodyy: "x" } } })).rejects.toThrow(/WrfComment/);
    });

    it("rejects a relation filter in write criteria with its own message", async () => {
      await expect(em.delete(WrfPost, { comments: { none: {} } } as any)).rejects.toThrow(
        /"comments" in the .* of "WrfPost" is a relation filter .* which this statement does not support/,
      );
      expect(await em.count(WrfPost)).toBe(4);
    });
  });
});

describe("[Integration] SQLite: relation filters on inheritance targets", () => {
  @Entity({ name: "wrfi_owners" })
  class IOwner {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
    @OneToMany(() => IAsset, { mappedBy: "owner" }) assets!: IAsset[];
    @OneToMany(() => IMachine, { mappedBy: "operator" }) machines!: IMachine[];
  }

  // TABLE_PER_CLASS: a vehicle's row lives in its own table, not the root's.
  @Entity({ name: "wrfi_assets" })
  @Inheritance({ strategy: "TABLE_PER_CLASS" })
  class IAsset {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) label!: string;
    @ManyToOne(() => IOwner, (o: IOwner) => o.assets)
    @RelationColumn({ name: "owner_id" })
    owner!: Relation<IOwner>;
  }

  @Entity({ name: "wrfi_vehicles" })
  @DiscriminatorValue("vehicle")
  class IVehicle extends IAsset {
    @Column({ type: "int" }) wheels!: number;
  }

  // JOINED: a machine's inherited `name` lives on the equipment table.
  @Entity({ name: "wrfi_equipment" })
  @Inheritance({ strategy: "JOINED" })
  class IEquipment {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
  }

  @Entity({ name: "wrfi_machines" })
  @DiscriminatorValue("machine")
  class IMachine extends IEquipment {
    @Column({ type: "int" }) power!: number;
    @ManyToOne(() => IOwner, (o: IOwner) => o.machines)
    @RelationColumn({ name: "operator_id" })
    operator!: Relation<IOwner>;
  }

  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [IOwner, IAsset, IVehicle, IEquipment, IMachine],
      connectionName: "wrf_inheritance",
    });
    const alice = await em.save(IOwner, { name: "alice" });
    const bob = await em.save(IOwner, { name: "bob" });
    await em.save(IVehicle, { label: "truck", wheels: 6, owner: alice } as any);
    await em.save(IAsset, { label: "desk", owner: bob } as any);
    await em.save(IMachine, { name: "lathe", power: 3, operator: bob } as any);
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const names = async (where: any) =>
    (await em.find(IOwner, { where, orderBy: { id: "ASC" } })).map((o) => o.name);

  it("reads a TABLE_PER_CLASS root's subclass rows", async () => {
    expect(await names({ assets: { some: { label: "truck" } } })).toEqual(["alice"]);
    expect(await names({ assets: { some: { label: "desk" } } })).toEqual(["bob"]);
  });

  it("reads a JOINED child's inherited columns", async () => {
    expect(await names({ machines: { some: { name: "lathe", power: { gte: 3 } } } })).toEqual(["bob"]);
    expect(await names({ machines: { none: {} } })).toEqual(["alice"]);
  });
});

describe("[Integration] SQLite: relation filters under tenant_column", () => {
  @Entity({ name: "wrft_users" })
  class TUser {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
  }

  @Entity({ name: "wrft_posts" })
  class TPost {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) title!: string;
    @ManyToOne(() => TUser, (u: TUser) => u.id, { createForeignKeyConstraints: false })
    @RelationColumn({ name: "author_id" })
    author!: Relation<TUser> | null;
  }

  let em: EntityManager;

  beforeAll(async () => {
    MetadataContext.reset();
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [TUser, TPost],
        synchronize: true,
        tenantStrategy: "tenant_column",
        logging: false,
      },
      "wrf_tenant",
    );
  });

  afterAll(async () => {
    await em.propagateShutdown({ closeConnections: true });
    MetadataContext.reset();
  });

  it("does not match a related row of another tenant", async () => {
    const foreign = await MetadataContext.run("globex", () => em.save(TUser, { name: "mallory" }));
    await MetadataContext.run("acme", async () => {
      await em.save(TPost, { title: "acme", authorId: foreign.id } as any);
      expect(await em.count(TPost, { author: { is: { name: "mallory" } } })).toBe(0);
      expect(await em.count(TPost, { author: { is: null } })).toBe(1);
    });
  });
});

// A parent keyed by two columns: a single join column cannot say which part
// of the key it holds, so the filter is refused unless the relation names
// the referenced column.
@Entity({ name: "wrf_orders" })
class WrfOrder {
  @PrimaryColumn({ type: "varchar", length: 10 }) tenantCode!: string;
  @PrimaryColumn({ type: "int" }) orderNo!: number;
  @OneToMany(() => WrfLine, { mappedBy: "order" }) lines!: WrfLine[];
}

@Entity({ name: "wrf_lines" })
class WrfLine {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => WrfOrder, (o: WrfOrder) => o.lines)
  @RelationColumn({ name: "order_no" })
  order!: Relation<WrfOrder>;
}

describe("[Integration] SQLite: relation filters on a composite key", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [WrfOrder, WrfLine], synchronize: false });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("refuses to correlate on one part of a composite key", async () => {
    await expect(
      em.find(WrfOrder, { where: { lines: { some: {} } } }),
    ).rejects.toThrow(InvalidQueryError);
    await expect(
      em.find(WrfOrder, { where: { lines: { some: {} } } }),
    ).rejects.toThrow(/"WrfOrder" has a composite primary key \(tenantCode, orderNo\)/);
    await expect(
      em.find(WrfLine, { where: { order: { is: { orderNo: 1 } } } }),
    ).rejects.toThrow(/composite primary key/);
  });
});
