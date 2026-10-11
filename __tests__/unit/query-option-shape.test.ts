/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Read options and where clauses built at runtime are checked for shape on
 * entry. Each shape below used to fail far from its cause (a TypeError, a
 * RangeError from the driver, a "no such column" naming an array index) or
 * to run with the option ignored.
 */
import "reflect-metadata";
import { validateReadOptionShape, assertWhereArgument } from "../../src/core/QueryOptionShape";
import {
  buildColumnNameScope,
  validateWhereIdentifiers,
  type ColumnNameScope,
} from "../../src/core/ColumnNameValidator";
import { normalizePage } from "../../src/core/PagePagination";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

function errorOf(fn: () => unknown): any {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

function column(name: string, type: string, extra: Record<string, unknown> = {}): any {
  return { target: class {}, propertyKey: name, name, type: undefined, options: { type, ...extra } };
}

const scope: ColumnNameScope = buildColumnNameScope({
  entityName: "Post",
  columns: [
    column("id", "int"),
    column("title", "varchar"),
    column("views", "int"),
    column("meta", "json"),
    column("price", "varchar", { transformer: { to: (v: any) => String(v?.amount), from: (v: any) => v } }),
    column("location", "point"),
  ],
  propertyToColumn: new Map([["authorId", "author_id"]]),
});

function whereError(where: unknown, clause: "where" | "criteria" = "where"): any {
  return errorOf(() => validateWhereIdentifiers(where, scope, clause));
}

describe("validateReadOptionShape", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["a numeric string take", { take: "10" }, `'take' must be a non-negative integer, got "10".`],
    ["a fractional take", { take: 1.5 }, "'take' must be a non-negative integer, got 1.5."],
    ["a string skip", { skip: "a" }, `'skip' must be a non-negative integer, got "a".`],
    ["a one-element limit", { limit: [0] }, "'limit' must be a count or an [offset, count] pair, got an array of 1."],
    ["a negative limit offset", { limit: [-1, 5] }, "'limit[0]' must be a non-negative integer, got -1."],
    ["a string limit", { limit: "2" }, `'limit' must be a non-negative integer, got "2".`],
    ["a string orderBy", { orderBy: "title" }, `'orderBy' must be an object keyed by property, such as { createdAt: "DESC" }, got "title".`],
    ["an unknown direction", { orderBy: { title: "UP" } }, `'orderBy.title' must be "ASC" or "DESC", got "UP".`],
    ["a string select", { select: "title" }, `'select' must be an array of property names or an object keyed by property, got "title".`],
    ["a string groupBy", { groupBy: "title" }, `'groupBy' must be an array of property names, got "title".`],
    ["a scalar where", { where: 5 }, "'where' must be an object or an array of objects, got 5."],
    ["a string withDeleted", { withDeleted: "yes" }, `'withDeleted' must be a boolean, got "yes".`],
    ["an unknown lock mode", { lock: "WRITE" }, `'lock' must be one of "PESSIMISTIC_READ", "PESSIMISTIC_WRITE"`],
    ["a NaN timeout", { timeout: NaN }, "'timeout' must be a non-negative number, got NaN."],
    ["a cache object with an unknown key", { cache: { ttll: 5 } }, "'cache' has no option 'ttll'. Did you mean 'ttl'?"],
    ["a typo'd option key", { wher: { id: 1 } }, "Unknown option 'wher'. Did you mean 'where'?"],
    ["an option in the wrong case", { orderby: { id: "ASC" } }, "Unknown option 'orderby'. Did you mean 'orderBy'?"],
  ])("rejects %s", (_label, option, expected) => {
    const error = errorOf(() => validateReadOptionShape(option, "find", "Post"));

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
    expect(error.message).toContain(`Invalid options passed to find() for entity "Post":\n  - `);
    expect(error.message).toContain(expected);
  });

  it("lists every problem at once", () => {
    const error = errorOf(() => validateReadOptionShape({ take: "10", skip: "a" }, "find", "Post"));

    expect(error.message.split("\nSuggestion:")[0]).toBe(
      `Invalid options passed to find() for entity "Post":\n` +
        `  - 'take' must be a non-negative integer, got "10".\n` +
        `  - 'skip' must be a non-negative integer, got "a".`,
    );
    expect(error.suggestion).toBe("Values read from a query string arrive as strings: convert them before passing them on.");
  });

  it("names the options of the method when a key is unknown", () => {
    const error = errorOf(() => validateReadOptionShape({ cursr: "x" }, "findWithCursor", "Post", "cursor"));

    expect(error.message).toContain("Unknown option 'cursr'. Did you mean 'cursor'?");
    expect(error.suggestion).toBe(
      "findWithCursor() takes: where, take, cursor, orderBy, direction, relations, withCount, withDeleted, useMaster, timeout, withoutTenantScope, cache.",
    );
  });

  it("accepts every documented shape, and treats undefined and null as not set", () => {
    expect(() =>
      validateReadOptionShape(
        {
          where: [{ id: 1 }, { title: "x" }],
          select: ["id"],
          orderBy: { id: "desc", title: undefined },
          limit: [0, 10],
          take: 0,
          skip: 5,
          groupBy: ["id"],
          having: [],
          withDeleted: false,
          onlyDeleted: undefined,
          timeout: 100,
          useMaster: true,
          lock: "PESSIMISTIC_WRITE",
          distinct: true,
          withoutTenantScope: false,
          cache: { ttl: 1000, tag: "posts" },
          relations: ["author"],
          withCount: { commentCount: "comments" },
          extra: undefined,
        },
        "find",
        "Post",
      ),
    ).not.toThrow();
    expect(() => validateReadOptionShape({ take: null, limit: null, where: null }, "find", "Post")).not.toThrow();
    expect(() => validateReadOptionShape(undefined, "find", "Post")).not.toThrow();
  });

  it("rejects options that are not an object, and missing options where they are required", () => {
    expect(errorOf(() => validateReadOptionShape(null, "find", "Post")).message).toBe(
      `find() for entity "Post" takes an options object, got null.\nSuggestion: Write find(Post, { where: { id: 1 } }).`,
    );
    expect(errorOf(() => validateReadOptionShape(undefined, "findOne", "Post", "find", true)).message).toContain(
      `findOne() for entity "Post" takes an options object, got undefined.`,
    );
  });

  describe("findWithCursor", () => {
    it("points an object orderBy at orderBy + direction", () => {
      const error = errorOf(() =>
        validateReadOptionShape({ orderBy: { createdAt: "desc" } }, "findWithCursor", "Post", "cursor"),
      );

      expect(error.message).toContain(
        `'orderBy' names one property to sort by, got an object. findWithCursor() pages by a single column: write orderBy: "createdAt", direction: "DESC".`,
      );
    });

    it.each<[string, Record<string, unknown>, string]>([
      ["a string take", { take: "abc" }, `'take' must be an integer, got "abc".`],
      ["an unknown direction", { direction: "up" }, `'direction' must be "ASC" or "DESC", got "up".`],
      ["a numeric cursor", { cursor: 5 }, "'cursor' must be the nextCursor string of a previous page, got 5."],
      ["an array where", { where: [{ id: 1 }] }, "'where' must be one where object, got an array."],
      ["a find-only option", { skip: 10 }, "Unknown option 'skip'."],
    ])("rejects %s", (_label, option, expected) => {
      const error = errorOf(() => validateReadOptionShape(option, "findWithCursor", "Post", "cursor"));

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(expected);
    });

    it("accepts a null cursor and a take below 1, which reads the default page size", () => {
      expect(() =>
        validateReadOptionShape({ cursor: null, take: 0, orderBy: "id", direction: "asc" }, "findWithCursor", "Post", "cursor"),
      ).not.toThrow();
    });
  });

  describe("findWithPage", () => {
    it("rejects a numeric string page and a fractional pageSize", () => {
      const error = errorOf(() =>
        validateReadOptionShape({ page: "2", pageSize: 2.5 }, "findWithPage", "Post", "page"),
      );

      expect(error.message).toContain(`'page' must be a number, got "2".`);
      expect(error.message).toContain("'pageSize' must be an integer, got 2.5.");
    });

    it("keeps flooring a fractional page", () => {
      expect(normalizePage(2.7)).toBe(2);
      expect(normalizePage(0)).toBe(1);
      expect(() => normalizePage("2" as any)).toThrow(`'page' must be a number, got "2".`);
    });
  });
});

describe("assertWhereArgument", () => {
  it("rejects a bare value passed as the where of a filter-first read", () => {
    const error = errorOf(() => assertWhereArgument(1, "findOneBy", "Post"));

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain(`findOneBy() for entity "Post" takes a where object or an array of them, got 1.`);
    expect(error.suggestion).toContain("findByPK(Post, id) reads by primary key");
  });

  it("accepts an object, an array and a missing where", () => {
    expect(() => assertWhereArgument({ id: 1 }, "findBy", "Post")).not.toThrow();
    expect(() => assertWhereArgument([{ id: 1 }], "findBy", "Post")).not.toThrow();
    expect(() => assertWhereArgument(undefined, "pluck", "Post")).not.toThrow();
  });
});

describe("validateWhereIdentifiers: where shape", () => {
  it.each<[string, unknown, string]>([
    ["a string where", "title = 1", `expected an object or an array of objects, got "title = 1".`],
    ["a scalar element of the array form", [{ id: 1 }, 2], "where[1] must be an object, got 2."],
    ["an object under OR", { OR: { title: "a" } }, `where.OR takes an array of where objects, got {"title":"a"}.`],
    ["an object under AND", { AND: { title: "a" } }, `where.AND takes an array of where objects, got {"title":"a"}.`],
    ["a scalar inside OR", { OR: [1] }, "where.OR[0] must be an object, got 1."],
    ["an array under NOT", { NOT: [{ title: "a" }] }, "where.NOT takes one where object, got an array."],
    ["an unknown operator", { title: { lik: "%a%" } }, `unknown operator "lik" on "title" (where.title). Did you mean "like"?`],
    ["an unknown operator next to a known one", { title: { eq: "a", lik: "b" } }, `unknown operator "lik" on "title" (where.title).`],
    ["an unknown operator under not", { title: { not: { lik: "a" } } }, `unknown operator "lik" on "title" (where.title.not).`],
    ["an empty filter object", { title: {} }, `"title" (where.title) is an empty object.`],
    ["a string for in", { title: { in: "a" } }, `operator "in" on "title" (where.title.in) needs an array, got "a".`],
    ["a three-element between", { views: { between: [1, 2, 3] } }, `operator "between" on "views" (where.views.between) needs [min, max], got an array of 3.`],
    ["a number for contains", { title: { contains: 5 } }, `operator "contains" on "title" (where.title.contains) needs a string, got 5.`],
    ["a number for like", { title: { like: 5 } }, `operator "like" on "title" (where.title.like) needs a string, got 5.`],
    ["a string for isNull", { title: { isNull: "no" } }, `operator "isNull" on "title" (where.title.isNull) needs true or false, got "no".`],
    ["an array for eq", { views: { eq: [1] } }, `operator "eq" on "views" (where.views.eq) needs a single value, got an array of 1.`],
    ["an object for gt", { views: { gt: { a: 1 } } }, `operator "gt" on "views" (where.views.gt) needs a single value, got an object.`],
    ["an array for not", { title: { not: ["a"] } }, `operator "not" on "title" (where.title.not) needs one value or an operator object, got an array of 1.`],
    ["an operator nested under OR", { OR: [{ title: { lik: "a" } }] }, `unknown operator "lik" on "title" (where.OR[0].title).`],
  ])("rejects %s", (_label, where, expected) => {
    const error = whereError(where);

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain(`Invalid where for entity "Post": ${expected}`);
  });

  it("names the criteria and points at deleteMany for a list of keys", () => {
    const error = whereError([1, 2], "criteria");

    expect(error.message).toContain(`Invalid criteria for entity "Post": criteria[0] must be an object, got 1.`);
    expect(error.suggestion).toContain("deleteMany(Entity, ids) deletes rows by primary key.");
  });

  it("reports an unknown column before its operators", () => {
    expect(whereError({ titel: { lik: "a" } }).message).toContain(`Unknown column "titel" in "where" for entity "Post".`);
  });

  it("treats an object on a json, custom-type or transformed column as a value", () => {
    expect(whereError({ meta: { theme: "dark" } })).toBeNull();
    expect(whereError({ meta: {} })).toBeNull();
    expect(whereError({ location: { x: 1, y: 2 } })).toBeNull();
    expect(whereError({ price: { amount: 5, currency: "EUR" } })).toBeNull();
    expect(whereError({ price: { gt: { amount: 5 } } })).toBeNull();
    expect(whereError({ meta: { eq: 1, theme: "dark" } })).toBeNull();
  });

  it("still checks the operators a json column's filter names", () => {
    expect(whereError({ meta: { in: "a" } }).message).toContain(`operator "in" on "meta" (where.meta.in) needs an array`);
    expect(whereError({ meta: { isNull: 1 } }).message).toContain(`operator "isNull" on "meta"`);
  });

  it("accepts every documented operator shape", () => {
    expect(
      whereError({
        id: [1, 2],
        title: { like: "a%", notLike: "b%", contains: "c", startsWith: "d", endsWith: "e", ne: null },
        views: { gt: 1, gte: 1, lt: 9, lte: 9, between: [1, 9], in: [], notIn: [3], not: { in: [4] } },
        authorId: null,
        OR: [{ title: { isNull: true } }, { views: { not: 5 } }],
        AND: [{ id: { eq: 1 } }],
        NOT: { title: "x" },
        skipped: undefined,
      }),
    ).toBeNull();
  });
});
