/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Result types of the read methods: a `select`, or a `select` in an entry of
 * the object form of `relations`, narrows each returned entity to what the
 * read loads. Every other read keeps the entity type — including options
 * typed as a plain `FindOption<T>` and generic code that forwards them —
 * and option typos are still compile errors.
 *
 * The checks are static: ts-jest type-checks this file, and the functions
 * holding the reads are never called.
 */
import "reflect-metadata";
import type { EntityManager } from "../../src/core/EntityManager";
import type { BaseRepository } from "../../src/core/BaseRepository";
import type { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";
import type { FindOption } from "../../src/dialects/FindOption";
import type { FindResult } from "../../src/types/FindResult";
import type { ClazzType } from "../../src/utils/types";
import { defineEntity, t } from "../../src/schema";

type Equal<X, Y> =
  (<V>() => V extends X ? 1 : 2) extends (<V>() => V extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

class Team {
  id!: number;
  name!: string;
  motto!: string;
}

class User {
  id!: number;
  name!: string;
  email!: string;
  private secret = "";
  team!: Team | null;
  posts!: Post[];
  manager!: Promise<User>;
  postCount?: number;
  greet(): string {
    return `hi ${this.name}`;
  }
}

class Post {
  id!: number;
  title!: string;
  body!: string;
  author!: User | null;
  comments!: Remark[];
}

class Remark {
  id!: number;
  body!: string;
  score!: number;
  author!: User;
}

declare const em: EntityManager;

describe("find() result types", () => {
  it("narrows to the selected properties, keeping methods", () => {
    async function reads() {
      const listed = await em.find(User, { select: ["id", "name"] });
      const flagged = await em.find(User, { select: { id: true, email: true, name: false } });
      const readonlyList = await em.find(User, { select: ["id", "name"] as const });
      type _listed = Expect<Equal<typeof listed, Pick<User, "id" | "name" | "greet">[]>>;
      type _flagged = Expect<Equal<typeof flagged, Pick<User, "id" | "email" | "greet">[]>>;
      type _readonly = Expect<Equal<typeof readonlyList, Pick<User, "id" | "name" | "greet">[]>>;
      listed[0].greet();
      // @ts-expect-error — email was not selected
      listed[0].email;
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("keeps the entity type when nothing narrows it", () => {
    async function reads(options: FindOption<User>) {
      const plain = await em.find(User, { where: { name: "a" }, orderBy: { id: "ASC" } });
      const listed = await em.find(Post, { relations: ["author", "comments.author"] });
      const objectForm = await em.find(Post, { relations: { author: true, comments: { take: 3 } } });
      const forwarded = await em.find(User, options);
      const everyColumn = await em.find(Team, { select: ["id", "name", "motto"] });
      type _plain = Expect<Equal<typeof plain, User[]>>;
      type _listed = Expect<Equal<typeof listed, Post[]>>;
      type _object = Expect<Equal<typeof objectForm, Post[]>>;
      type _forwarded = Expect<Equal<typeof forwarded, User[]>>;
      type _every = Expect<Equal<typeof everyColumn, Team[]>>;
    }
    function generic<E>(entity: ClazzType<E>, options: FindOption<E>): Promise<E[]> {
      return em.find(entity, options);
    }
    expect([reads, generic]).toHaveLength(2);
  });

  it("keeps the relations a select read loads, and the counts it writes", () => {
    async function reads() {
      const posts = await em.find(Post, { select: ["title"], relations: ["author", "comments.author"] });
      const users = await em.find(User, { select: ["name"], withCount: { postCount: "posts" } });
      type _posts = Expect<Equal<typeof posts, Pick<Post, "title" | "author" | "comments">[]>>;
      type _users = Expect<Equal<typeof users, Pick<User, "name" | "postCount" | "greet">[]>>;
      // @ts-expect-error — body was not selected
      posts[0].body;
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("narrows a relation whose entry selects columns, at any depth", () => {
    async function reads() {
      const posts = await em.find(Post, {
        relations: {
          author: { select: ["name"] },
          comments: { select: ["body"], take: 2, relations: { author: { select: ["email"] } } },
        },
      });
      const post = posts[0];
      type _author = Expect<Equal<typeof post.author, FindResult<User, ["name"]> | null>>;
      const name: string | undefined = post.author?.name;
      const email: string = post.comments[0].author.email;
      post.title;
      // @ts-expect-error — the author's email was not selected
      post.author?.email;
      // @ts-expect-error — a comment's score was not selected
      post.comments[0].score;
      // @ts-expect-error — the nested author's name was not selected
      post.comments[0].author.name;
      return [name, email];
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("combines a select with a relation's own select", () => {
    async function reads() {
      const [post] = await em.find(Post, { select: ["title"], relations: { author: { select: ["name"] } } });
      post.title;
      post.author?.name;
      // @ts-expect-error — not selected
      post.body;
      // @ts-expect-error — not selected on the author
      post.author?.email;
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("keeps a lazy relation's declared type", () => {
    async function reads() {
      const users = await em.find(User, { relations: { manager: { select: ["name"] } } });
      type _manager = Expect<Equal<(typeof users)[number]["manager"], Promise<User>>>;
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("still rejects typos in every option", () => {
    async function reads() {
      // @ts-expect-error — "nmae" is not a property of User
      await em.find(User, { select: ["nmae"] });
      // @ts-expect-error — "nmae" is not a column of User, beside a select
      await em.find(User, { select: ["id"], where: { nmae: "a" } });
      // @ts-expect-error — "wher" is not an option
      await em.find(User, { wher: { id: 1 } });
      // @ts-expect-error — "nmae" is not a property of the related User
      await em.find(Post, { relations: { author: { select: ["nmae"] } } });
      // @ts-expect-error — a nested options object is not a select flag
      await em.find(Post, { select: { title: true, author: { select: ["name"] } } });
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("leaves an untyped entity untyped", () => {
    async function reads(Entity: ClazzType<any>) {
      const rows = await em.find(Entity, { select: ["anything"] });
      type _rows = Expect<Equal<typeof rows, any[]>>;
    }
    expect(reads).toBeInstanceOf(Function);
  });
});

describe("result types across the read methods", () => {
  it("narrows findOne, findOneOrFail, findAndCount, the pages and the streams", () => {
    type Picked = Pick<User, "id" | "name" | "greet">;
    async function reads() {
      const one = await em.findOne(User, { where: { id: 1 }, select: ["id", "name"] });
      const sure = await em.findOneOrFail(User, { where: { id: 1 }, select: ["id", "name"] });
      const [rows, total] = await em.findAndCount(User, { select: ["id", "name"] });
      const page = await em.findWithPage(User, { page: 1, select: ["id", "name"] });
      const cursor = await em.findWithCursor(Post, { take: 10, relations: { author: { select: ["name"] } } });
      type _one = Expect<Equal<typeof one, Picked | null>>;
      type _sure = Expect<Equal<typeof sure, Picked>>;
      type _rows = Expect<Equal<typeof rows, Picked[]>>;
      type _page = Expect<Equal<(typeof page)["data"], Picked[]>>;
      cursor.data[0].author?.name;
      // @ts-expect-error — not selected
      cursor.data[0].author?.email;
      for await (const user of em.stream(User, { select: ["id", "name"] })) {
        type _streamed = Expect<Equal<typeof user, Picked>>;
      }
      for await (const batch of em.streamBatch(User, { select: ["id", "name"] })) {
        type _batch = Expect<Equal<typeof batch, Picked[]>>;
      }
      return total;
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("narrows on a repository and on a MultiTenantEntityManager", () => {
    async function reads(repo: BaseRepository<User>, tenants: MultiTenantEntityManager) {
      const fromRepo = await repo.find({ select: ["id", "name"] });
      const fromTenant = await tenants.find(User, { select: ["id", "name"] });
      const plain = await repo.find({ where: { id: 1 } });
      type _repo = Expect<Equal<typeof fromRepo, Pick<User, "id" | "name" | "greet">[]>>;
      type _tenant = Expect<Equal<typeof fromTenant, Pick<User, "id" | "name" | "greet">[]>>;
      type _plain = Expect<Equal<typeof plain, User[]>>;
    }
    expect(reads).toBeInstanceOf(Function);
  });

  it("narrows an entity built with defineEntity()", () => {
    const Account = defineEntity("frt_accounts", {
      id: t.int().primary().generated(),
      handle: t.varchar(40),
      bio: t.text().nullable(),
    });
    async function reads() {
      const [account] = await em.find(Account, { select: ["handle"] });
      const handle: string = account.handle;
      // @ts-expect-error — bio was not selected
      account.bio;
      return handle;
    }
    expect(reads).toBeInstanceOf(Function);
  });
});
