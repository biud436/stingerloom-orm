/**
 * Relation filters in `WhereClause`: the shape check the resolver uses to
 * tell them from column operators, and their static typing — collection
 * relations take `some` / `none` / `every`, single-valued ones `is` /
 * `isNot`, each typed against the related entity.
 */
import "reflect-metadata";
import { isRelationFilter } from "../../src/core/WhereResolver";
import type { WhereClause } from "../../src/dialects/FindOption";

class Tag {
  id!: number;
  label!: string;
}
class Comment {
  id!: number;
  body!: string;
  approved!: boolean;
  author!: User;
}
class User {
  id!: number;
  name!: string;
  manager!: Promise<User>;
}
class Post {
  id!: number;
  title!: string;
  meta!: Record<string, unknown>;
  author!: User | null;
  comments!: Comment[];
  tags!: Tag[];
}

describe("isRelationFilter", () => {
  it.each([
    [{ some: {} }, true],
    [{ none: { a: 1 }, every: {} }, true],
    [{ is: null }, true],
    [{ isNot: { name: "x" } }, true],
    [{}, false],
    [{ some: {}, eq: 1 }, false],
    [{ eq: 1 }, false],
    [[{ some: {} }], false],
    [null, false],
    [new (class Some { some = 1; })(), false],
  ])("%j -> %s", (value, expected) => {
    expect(isRelationFilter(value)).toBe(expected);
  });
});

describe("relation filter typing", () => {
  it("accepts the filters that fit each relation, typed against the related entity", () => {
    const ok: WhereClause<Post> = {
      title: "x",
      comments: { some: { approved: true, author: { is: { name: "alice" } } }, none: [{ body: "spam" }] },
      tags: { every: { label: { startsWith: "o" } } },
      author: { isNot: null },
    };
    const lazy: WhereClause<User> = { manager: { is: { name: "boss" } } };
    expect([ok, lazy]).toHaveLength(2);
  });

  it("rejects a filter key that does not fit, and a column the related entity lacks", () => {
    // @ts-expect-error — a collection takes some / none / every, not is
    const collectionIs: WhereClause<Post> = { comments: { is: {} } };
    // @ts-expect-error — a single-valued relation takes is / isNot, not some
    const toOneSome: WhereClause<Post> = { author: { some: {} } };
    // @ts-expect-error — "bodyy" is not a column of Comment
    const typo: WhereClause<Post> = { comments: { some: { bodyy: "x" } } };
    expect([collectionIs, toOneSome, typo]).toHaveLength(3);
  });
});
