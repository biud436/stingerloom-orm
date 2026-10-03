/**
 * `relations` normalization: every accepted form (names, dotted paths, the
 * object form, any mix across levels) becomes one tree, and every malformed
 * option is rejected with the path of the offending entry instead of being
 * dropped. Name-against-metadata checks live in the integration suites; this
 * file pins the pure parse and the option's static typing.
 */
import "reflect-metadata";
import {
  parseRelationsOption,
  relationTreeKey,
  requestedRelationNames,
  hasNestedRelations,
  type RelationTree,
} from "../../src/core/RelationTree";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import type {
  RelationPropertyKeys,
  RelationsOption,
  RelationTarget,
} from "../../src/dialects/FindOption";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

function parse(relations: unknown): RelationTree {
  const tree = parseRelationsOption(relations);
  if (!tree) throw new Error("expected a tree");
  return tree;
}

function captureError(run: () => unknown): InvalidQueryError {
  try {
    run();
  } catch (error) {
    return error as InvalidQueryError;
  }
  throw new Error("expected an error");
}

describe("parseRelationsOption", () => {
  it("returns undefined when no option was given", () => {
    expect(parseRelationsOption(undefined)).toBeUndefined();
    expect(parseRelationsOption(null)).toBeUndefined();
  });

  it("keeps an empty array or object as an empty tree", () => {
    expect(parse([]).names).toEqual([]);
    expect(parse({}).names).toEqual([]);
  });

  it("turns names into a flat level in request order", () => {
    const tree = parse(["author", "tags"]);
    expect(tree.names).toEqual(["author", "tags"]);
    expect(hasNestedRelations(tree)).toBe(false);
  });

  it("splits dotted paths into nested levels and merges shared prefixes", () => {
    const tree = parse(["comments", "comments.author", "comments.author.team", "author"]);
    expect(tree.names).toEqual(["comments", "author"]);
    expect(relationTreeKey(tree)).toBe("comments(author(team)),author");
    expect(hasNestedRelations(tree)).toBe(true);
  });

  it("reads the object form, skipping false and undefined", () => {
    const tree = parse({
      author: true,
      editor: false,
      reviewer: undefined,
      comments: { relations: { author: true } },
    });
    expect(relationTreeKey(tree)).toBe("author,comments(author)");
  });

  it("accepts any form at a nested level and merges it with dotted paths", () => {
    const tree = parse({
      comments: { relations: ["author.team", "likes"] },
    });
    expect(relationTreeKey(tree)).toBe("comments(author(team),likes)");
  });

  it("treats an options object without nested relations as a plain load", () => {
    expect(relationTreeKey(parse({ author: {} }))).toBe("author");
    expect(hasNestedRelations(parse({ author: {} }))).toBe(false);
  });

  it("rejects a non-string array entry", () => {
    const error = captureError(() => parse(["author", 3]));
    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain('"relations" lists number 3');
  });

  it("rejects an empty path segment with the full path", () => {
    const error = captureError(() => parse({ comments: { relations: ["author..team"] } }));
    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain('Relation path "comments.author..team"');
  });

  it("rejects an option key it does not know, naming the relation", () => {
    const error = captureError(() => parse({ comments: { relations: { author: { wher: {} } } } }));
    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain('Unknown option "wher" for relation "comments.author"');
    expect(error.suggestion).toContain("relations");
  });

  it("rejects a relation value that is neither boolean nor an options object", () => {
    const error = captureError(() => parse({ author: "yes" }));
    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain('Relation "author" in "relations" is string "yes"');
  });

  it("rejects an option that is neither an array nor a plain object", () => {
    expect(captureError(() => parse("author")).message).toContain(
      '"relations" must be an array of relation names or an object',
    );
    expect(captureError(() => parse({ author: { relations: 5 } })).message).toContain(
      'The "relations" of "author" must be an array',
    );
  });
});

describe("requestedRelationNames", () => {
  it("returns a plain name array as is", () => {
    const names = ["author", "tags"];
    expect(requestedRelationNames(names)).toBe(names);
  });

  it("returns the top level of every other form", () => {
    expect(requestedRelationNames(["comments.author", "tags"])).toEqual(["comments", "tags"]);
    expect(requestedRelationNames({ author: true, comments: { relations: ["author"] } })).toEqual([
      "author",
      "comments",
    ]);
  });

  it("returns undefined when no option was given", () => {
    expect(requestedRelationNames(undefined)).toBeUndefined();
  });
});

describe("relations option typing", () => {
  class Team {
    id!: number;
    title!: string;
    members!: User[];
  }
  class User {
    id!: number;
    name!: string;
    createdAt!: Date;
    avatar!: Uint8Array;
    tags!: string[];
    team!: Team | null;
    posts!: Post[];
    lazyManager!: Promise<User>;
  }
  class Post {
    id!: number;
    author!: User;
  }

  it("offers only properties that can hold an entity", () => {
    type _keys = Expect<
      Equal<RelationPropertyKeys<User>, "team" | "posts" | "lazyManager">
    >;
    type _target = Expect<Equal<RelationTarget<User["posts"]>, Post>>;
    type _lazy = Expect<Equal<RelationTarget<User["lazyManager"]>, User>>;
    expect(true).toBe(true);
  });

  it("types the object form recursively and rejects unknown keys", () => {
    const ok: RelationsOption<User> = {
      team: { relations: { members: true } },
      posts: { relations: { author: { relations: ["team"] } } },
    };
    // @ts-expect-error — "nmae" is not a relation of User
    const typo: RelationsOption<User> = { nmae: true };
    // @ts-expect-error — "title" is a column of Team, not a relation
    const column: RelationsOption<User> = { team: { relations: { title: true } } };
    expect([ok, typo, column]).toHaveLength(3);
  });
});
