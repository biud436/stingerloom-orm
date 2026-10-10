/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Relation declarations that cannot resolve stop `register()`, and a
 * relation payload no write persists is reported under `unknownWriteKeys`.
 *
 * Before, each of these booted and failed later or not at all:
 * - a `mappedBy` typo died on the first relation load with
 *   `no such column: "autor"` (the typo was used as the FK column);
 * - a `@ManyToMany` pair with no `joinTable` on either side created no join
 *   table, and the relation was silently missing from every load;
 * - a relation target missing from `entities` died on the first write with
 *   `no such table: main.<target>`;
 * - an `inverseSide` typo loaded the relation as null forever;
 * - `save(User, { posts: [{ title }] })` without a cascade on `posts`
 *   saved the user, dropped the post and said nothing.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { Relation } from "../../../src/types/Relation";
import { defineEntity, t } from "../../../src/schema";
import { EntityManager } from "../../../src/core/EntityManager";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "rgi_users" })
class RgiUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => RgiPost, { mappedBy: "author" }) posts?: RgiPost[];
}

@Entity({ name: "rgi_posts" })
class RgiPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => RgiUser, (u: RgiUser) => u.posts, { joinColumn: "author_id" })
  author!: Relation<RgiUser>;
}

@Entity({ name: "rgi_typo_users" })
class RgiTypoUser {
  @PrimaryGeneratedColumn() id!: number;
  @OneToMany(() => RgiTypoPost, { mappedBy: "autor" }) posts?: RgiTypoPost[];
}

@Entity({ name: "rgi_typo_posts" })
class RgiTypoPost {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => RgiTypoUser, (u: RgiTypoUser) => u.posts, { joinColumn: "author_id" })
  author!: Relation<RgiTypoUser>;
}

const RgiCodeAuthor = defineEntity("rgi_code_authors", {
  id: t.int().primary().generated(),
  posts: t.oneToMany((): any => RgiCodePost, "writer"),
});

const RgiCodePost = defineEntity("rgi_code_posts", {
  id: t.int().primary().generated(),
  author: t.manyToOne(() => RgiCodeAuthor, { joinColumn: "author_id" }),
});

@Entity({ name: "rgi_m2m_posts" })
class RgiM2mPost {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgiM2mTag, {}) tags?: RgiM2mTag[];
}

@Entity({ name: "rgi_m2m_tags" })
class RgiM2mTag {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToMany(() => RgiM2mPost, {}) posts?: RgiM2mPost[];
}

@Entity({ name: "rgi_profiles" })
class RgiProfile {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => RgiAccount, { inverseSide: "profil" }) account?: Relation<RgiAccount> | null;
}

@Entity({ name: "rgi_accounts" })
class RgiAccount {
  @PrimaryGeneratedColumn() id!: number;
  @OneToOne(() => RgiProfile, { joinColumn: "profile_id" }) profile?: Relation<RgiProfile> | null;
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("[SQLite] relation declarations are validated at register()", () => {
  let dir: string;
  let database: string;
  const open: EntityManager[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgi-"));
    database = path.join(dir, "app.db");
  });

  afterEach(async () => {
    while (open.length > 0) await open.pop()!.propagateShutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function register(entities: any[], extra: Record<string, unknown> = {}) {
    const em = new EntityManager();
    open.push(em);
    await em.register({ type: "sqlite", database, entities, synchronize: true, logging: false, ...extra } as any);
    return em;
  }

  async function tables(): Promise<string[]> {
    // An empty entities list would check every entity this file declares.
    const em = await register([RgiUser, RgiPost], { synchronize: false });
    const rows: any[] = await em.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'rgi_%' ORDER BY name`,
    );
    return rows.map((r) => r.name);
  }

  it("rejects a mappedBy typo before any table is created", async () => {
    const error = await rejectionOf(() => register([RgiTypoUser, RgiTypoPost]));

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error?.message).toContain(
      `RgiTypoUser.posts: @OneToMany mappedBy "autor" names no @ManyToOne on RgiTypoPost. Did you mean "author"?`,
    );
    expect(await tables()).toEqual([]);
  });

  it("rejects a oneToMany typo in defineEntity the same way", async () => {
    const error = await rejectionOf(() => register([RgiCodeAuthor, RgiCodePost]));

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error?.message).toContain(`mappedBy "writer" names no @ManyToOne on rgi_code_posts`);
  });

  it("rejects a ManyToMany pair with no join table on either side", async () => {
    const error = await rejectionOf(() => register([RgiM2mPost, RgiM2mTag]));

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error?.message).toContain(
      `RgiM2mPost.tags: @ManyToMany declares neither joinTable nor mappedBy, so the relation has no join table.`,
    );
    expect(error?.message).toContain(`RgiM2mTag.posts: @ManyToMany declares neither joinTable nor mappedBy`);
  });

  it("rejects a relation target missing from entities, naming the connection", async () => {
    const em = new EntityManager();
    open.push(em);
    const error = await rejectionOf(() =>
      em.register({ type: "sqlite", database, entities: [RgiPost], synchronize: true, logging: false }, "blog"),
    );

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error?.message).toContain(`Invalid relation mapping (connection "blog")`);
    expect(error?.message).toContain(
      `RgiPost.author: @ManyToOne targets RgiUser, which is not in this connection's entities, so its table is never created. Add RgiUser to entities.`,
    );
    expect(await tables()).toEqual([]);
  });

  it("rejects an inverseSide typo instead of loading the relation as null", async () => {
    const error = await rejectionOf(() => register([RgiProfile, RgiAccount]));

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error?.message).toContain(
      `RgiProfile.account: @OneToOne inverseSide "profil" names no owning @OneToOne on RgiAccount. Did you mean "profile"?`,
    );
  });

  it("does not check an attach()ed subset of a registered connection", async () => {
    const em = new EntityManager();
    open.push(em);
    await em.register(
      { type: "sqlite", database, entities: [RgiUser, RgiPost], synchronize: true, logging: false },
      "rgi_owner",
    );
    const user = await em.save(RgiUser, { name: "ada" });

    const subset = new EntityManager();
    await subset.attach("rgi_owner", { entities: [RgiPost] });
    await subset.save(RgiPost, { title: "hello", author: user.id } as any);

    expect(await em.count(RgiPost, {})).toBe(1);
  });
});

describe("[SQLite] a relation payload no write persists follows unknownWriteKeys", () => {
  const open: EntityManager[] = [];

  afterEach(async () => {
    while (open.length > 0) await open.pop()!.propagateShutdown();
  });

  async function register(extra: Record<string, unknown> = {}) {
    const em = new EntityManager();
    open.push(em);
    await em.register({
      type: "sqlite",
      database: ":memory:",
      entities: [RgiUser, RgiPost],
      synchronize: true,
      logging: false,
      ...extra,
    } as any);
    return em;
  }

  it("warns once when a OneToMany without cascade holds a new row", async () => {
    const em = await register();
    const warn = jest.spyOn((em as any).logger, "warn").mockImplementation(() => undefined);

    await em.save(RgiUser, { name: "ada", posts: [{ title: "dropped" }] } as any);
    await em.save(RgiUser, { name: "bob", posts: [{ title: "dropped too" }] } as any);

    expect(await em.count(RgiPost, {})).toBe(0);
    const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(`Relation "posts"`));
    expect(warnings).toEqual([
      `[WriteInput] Relation "posts" in the data passed to save() for entity "RgiUser" holds a new row (no primary key value), ` +
        `but the @OneToMany has no cascade ["insert"], so the row is not written. ` +
        `Add cascade: ["insert"] to the relation, or save the row on its own first. ` +
        `Set unknownWriteKeys: "throw" to reject such writes, or "ignore" to silence this warning.`,
    ]);
  });

  it("stays quiet when a loaded relation is saved back", async () => {
    const em = await register();
    const ada = await em.save(RgiUser, { name: "ada" });
    await em.save(RgiPost, { title: "kept", author: ada.id } as any);
    const warn = jest.spyOn((em as any).logger, "warn").mockImplementation(() => undefined);

    const loaded = await em.findOne(RgiUser, { where: { id: ada.id }, relations: ["posts"] });
    await em.save(RgiUser, { ...loaded!, name: "ada lovelace" });
    await em.save(RgiPost, { title: "linked", author: loaded } as any);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("Relation "))).toEqual([]);
    expect(await em.count(RgiPost, {})).toBe(2);
  });

  it("warns when a ManyToOne holds a row with no key, which leaves the reference unset", async () => {
    const em = await register();
    const warn = jest.spyOn((em as any).logger, "warn").mockImplementation(() => undefined);

    const post = await em.save(RgiPost, { title: "orphan", author: { name: "new" } } as any);

    expect((post as any).author_id ?? null).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes(`Relation "author" in the data passed to save() for entity "RgiPost"`))).toBe(true);
  });

  it("says insertMany() does not cascade", async () => {
    const em = await register();
    const warn = jest.spyOn((em as any).logger, "warn").mockImplementation(() => undefined);

    await em.insertMany(RgiUser, [{ name: "ada", posts: [{ title: "dropped" }] }] as any);

    expect(warn.mock.calls.some((c) => String(c[0]).includes("but insertMany() does not cascade, so the row is not written"))).toBe(true);
  });

  it("throws under unknownWriteKeys: \"throw\" and writes nothing", async () => {
    const em = await register({ unknownWriteKeys: "throw" });

    const error = await rejectionOf(() => em.save(RgiUser, { name: "ada", posts: [{ title: "p" }] } as any));

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain(`Relation "posts" in the data passed to save() for entity "RgiUser" holds a new row`);
    expect(await em.count(RgiUser, {})).toBe(0);
  });
});
