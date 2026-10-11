/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Read options, where clauses and criteria built at runtime are rejected
 * on entry when they have the wrong shape.
 *
 * Before, each of these failed far from its cause or not at all:
 * - `{ title: { lik: "%p%" } }` → RangeError "Too few parameter values were provided";
 * - `{ title: { contains: 5 } }` → TypeError "s.replace is not a function";
 * - `{ title: { in: "p1" } }`, `{ title: { isNull: "no" } }` → silently [];
 * - `OR: { ... }` → TypeError "value.map is not a function";
 * - `NOT: [ ... ]`, `where: "..."`, `delete(E, "1")` → `no such column: "0"`;
 * - `orderBy: "title"` → "Invalid ORDER BY direction: t";
 * - `limit: [0]`, `take: 1.5` → SQLITE_MISMATCH; `take: "10"`, `skip: "a"` → silently used;
 * - `findOneBy(E, 1)`, `where: 5` → an arbitrary row / every row;
 * - `findWithCursor(E, { orderBy: { title: "ASC" } })` → `Unknown column "[object Object]"`;
 * - `createQueryBuilder(E)` → the raw builder, then "getMany is not a function".
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Relation } from "../../../src/types/Relation";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "qos_users" })
class QosUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => QosPost, { mappedBy: "author" }) posts?: QosPost[];
}

@Entity({ name: "qos_posts" })
class QosPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @Column({ type: "int" }) views!: number;
  @ManyToOne(() => QosUser, (u: QosUser) => u.posts)
  @RelationColumn({ name: "author_id" })
  author!: Relation<QosUser>;
}

async function rejectionOf(fn: () => unknown): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("[SQLite] read options, where clauses and criteria are checked for shape", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = new EntityManager();
    await em.register({
      type: "sqlite",
      database: ":memory:",
      entities: [QosUser, QosPost],
      synchronize: true,
      logging: false,
    });
    const ada = await em.save(QosUser, { name: "ada" });
    await em.save(QosPost, { title: "p1", views: 3, author: ada.id } as any);
    await em.save(QosPost, { title: "p2", views: 5, author: ada.id } as any);
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  async function expectRejected(fn: () => unknown, message: string): Promise<any> {
    const error = await rejectionOf(fn);
    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain(message);
    return error;
  }

  describe("where operators", () => {
    it.each<[string, Record<string, unknown>, string]>([
      ["an unknown operator", { title: { lik: "%p%" } }, `unknown operator "lik" on "title" (where.title). Did you mean "like"?`],
      ["a number for contains", { title: { contains: 5 } }, `operator "contains" on "title" (where.title.contains) needs a string, got 5.`],
      ["a string for in", { title: { in: "p1" } }, `operator "in" on "title" (where.title.in) needs an array, got "p1".`],
      ["a string for isNull", { title: { isNull: "no" } }, `operator "isNull" on "title" (where.title.isNull) needs true or false, got "no".`],
      ["a three-element between", { views: { between: [1, 9, 3] } }, `operator "between" on "views" (where.views.between) needs [min, max], got an array of 3.`],
      ["an object under OR", { OR: { title: "p1" } }, `where.OR takes an array of where objects, got {"title":"p1"}.`],
      ["an array under NOT", { NOT: [{ title: "p1" }] }, "where.NOT takes one where object, got an array."],
    ])("rejects %s", async (_label, where, message) => {
      await expectRejected(() => em.find(QosPost, { where } as any), `Invalid where for entity "QosPost": ${message}`);
    });

    it("rejects a relation given an object that is no relation filter", async () => {
      const error = await expectRejected(
        () => em.find(QosPost, { where: { author: { id: 1 } } } as any),
        `Invalid where for entity "QosPost": "author" (where.author) is a relation`,
      );
      expect(error.suggestion).toContain("Write author: { is: { id: 1 } } to filter by the related row");
    });

    it("checks a relation filter's nested where and the where of count()", async () => {
      await expectRejected(
        () => em.find(QosUser, { where: { posts: { some: { title: { lik: "p" } } } } } as any),
        `unknown operator "lik" on "title"`,
      );
      await expectRejected(() => em.count(QosPost, { views: { gt: [1] } } as any), `operator "gt" on "views"`);
    });

    it("still runs every valid operator", async () => {
      const rows = await em.find(QosPost, {
        where: {
          title: { in: ["p1", "p2"], not: { eq: "p9" } },
          views: { between: [1, 9] },
          OR: [{ title: { startsWith: "p" } }, { views: 0 }],
        },
        orderBy: { views: "DESC" },
      });

      expect(rows.map((p) => p.title)).toEqual(["p2", "p1"]);
    });
  });

  describe("find options", () => {
    it.each<[string, Record<string, unknown>, string]>([
      ["a scalar where", { where: 5 }, "'where' must be an object or an array of objects, got 5."],
      ["a string orderBy", { orderBy: "title" }, `'orderBy' must be an object keyed by property, such as { createdAt: "DESC" }, got "title".`],
      ["a one-element limit", { limit: [0] }, "'limit' must be a count or an [offset, count] pair, got an array of 1."],
      ["a numeric string take", { take: "10" }, `'take' must be a non-negative integer, got "10".`],
      ["a fractional take", { take: 1.5 }, "'take' must be a non-negative integer, got 1.5."],
      ["an unknown lock mode", { lock: "WRITE" }, `'lock' must be one of "PESSIMISTIC_READ"`],
      ["a typo'd option key", { wher: { title: "p1" } }, "Unknown option 'wher'. Did you mean 'where'?"],
    ])("rejects %s", async (_label, option, message) => {
      await expectRejected(() => em.find(QosPost, option as any), message);
    });

    it("applies the same check to findOne, findAndCount, findWithPage and stream", async () => {
      await expectRejected(() => (em as any).findOne(QosPost), `findOne() for entity "QosPost" takes an options object, got undefined.`);
      await expectRejected(() => em.findAndCount(QosPost, { skip: "a" } as any), "Invalid options passed to findAndCount()");
      await expectRejected(() => em.findWithPage(QosPost, { page: "2" } as any), `'page' must be a number, got "2".`);
      await expectRejected(async () => {
        for await (const post of em.stream(QosPost, { take: "1" } as any)) void post;
      }, "Invalid options passed to streamBatch()");
    });

    it("reads null pagination options as not set", async () => {
      const rows = await em.find(QosPost, { take: null, skip: null, limit: null } as any);

      expect(rows).toHaveLength(2);
    });
  });

  describe("filter-first reads and criteria", () => {
    it("rejects a bare value passed as a where", async () => {
      await expectRejected(
        () => em.findOneBy(QosPost, 1 as any),
        `findOneBy() for entity "QosPost" takes a where object or an array of them, got 1.`,
      );
      await expectRejected(
        () => em.exists(QosPost, "1" as any),
        `Invalid where for entity "QosPost": expected an object or an array of objects, got "1".`,
      );
    });

    it("rejects scalar criteria and points at deleteMany for a list of keys", async () => {
      await expectRejected(
        () => em.delete(QosPost, 1 as any),
        `Invalid criteria for entity "QosPost": expected an object or an array of objects, got 1.`,
      );
      await expectRejected(
        () => em.updateMany(QosPost, { views: 0 }, { where: "1" } as any),
        `Invalid where for entity "QosPost": expected an object or an array of objects, got "1".`,
      );
      const error = await expectRejected(
        () => em.delete(QosPost, [1, 2] as any),
        `Invalid criteria for entity "QosPost": criteria[0] must be an object, got 1.`,
      );
      expect(error.suggestion).toContain("deleteMany(Entity, ids) deletes rows by primary key.");
      expect(await em.count(QosPost, {})).toBe(2);
    });
  });

  describe("findWithCursor", () => {
    it("points an object orderBy at orderBy + direction", async () => {
      await expectRejected(
        () => em.findWithCursor(QosPost, { orderBy: { title: "ASC" } } as any),
        `'orderBy' names one property to sort by, got an object. findWithCursor() pages by a single column: write orderBy: "title", direction: "ASC".`,
      );
    });

    it("rejects a non-integer take and an array where", async () => {
      await expectRejected(() => em.findWithCursor(QosPost, { take: "abc" } as any), `'take' must be an integer, got "abc".`);
      await expectRejected(
        () => em.findWithCursor(QosPost, { where: [{ title: "p1" }] } as any),
        "'where' must be one where object, got an array.",
      );
    });
  });

  describe("createQueryBuilder", () => {
    it("rejects an entity without an alias instead of returning the raw builder", async () => {
      const error = await expectRejected(
        () => (em as any).createQueryBuilder(QosPost),
        "createQueryBuilder(QosPost) needs an alias, got none.",
      );
      expect(error.suggestion).toContain(`Write createQueryBuilder(QosPost, "q")`);
    });

    it("still builds with an alias, and returns the raw builder with no arguments", async () => {
      const rows = await em.createQueryBuilder(QosPost, "p").orderBy({ id: "ASC" }).getMany();

      expect(rows.map((p) => p.title)).toEqual(["p1", "p2"]);
      expect(typeof (em.createQueryBuilder() as any).getMany).toBe("undefined");
    });
  });
});
