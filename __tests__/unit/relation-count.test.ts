/**
 * `withCount` normalization and typing: the accepted forms (a relation name,
 * or `{ relation, where, withDeleted }`) become count specs, every malformed
 * entry is rejected with its property and relation path, a `withCount`
 * under `relations` lands on the node it belongs to, and the option's static
 * type only offers number properties and collection relations.
 * Name-against-metadata checks live in the integration suites.
 */
import "reflect-metadata";
import { parseWithCountOption } from "../../src/core/RelationCount";
import { parseRelationsOption } from "../../src/core/RelationTree";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import type {
  CollectionRelationKeys,
  CountPropertyKeys,
  FindOption,
  RelationsOption,
  WithCountOption,
} from "../../src/dialects/FindOption";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

function captureError(run: () => unknown): InvalidQueryError {
  try {
    run();
  } catch (error) {
    return error as InvalidQueryError;
  }
  throw new Error("expected an error");
}

describe("parseWithCountOption", () => {
  it("returns undefined when the option is absent or counts nothing", () => {
    expect(parseWithCountOption(undefined)).toBeUndefined();
    expect(parseWithCountOption(null)).toBeUndefined();
    expect(parseWithCountOption({})).toBeUndefined();
    expect(parseWithCountOption({ commentCount: undefined })).toBeUndefined();
  });

  it("reads a relation name and the options form, in key order", () => {
    expect(
      parseWithCountOption({
        commentCount: "comments",
        approvedCount: { relation: "comments", where: { approved: true }, withDeleted: false },
        tagCount: { relation: "tags", where: [{ label: "a" }, { label: "b" }] },
      }),
    ).toEqual([
      { property: "commentCount", relation: "comments" },
      { property: "approvedCount", relation: "comments", where: { approved: true }, withDeleted: false },
      { property: "tagCount", relation: "tags", where: [{ label: "a" }, { label: "b" }] },
    ]);
  });

  it.each([
    ["an array", ["comments"], /"withCount" must be an object keyed by the property/],
    ["a string", "comments", /"withCount" must be an object keyed by the property/],
    ["a non-string entry", { commentCount: true }, /"withCount\.commentCount" is boolean true/],
    ["an unknown entry option", { commentCount: { relation: "comments", take: 1 } }, /Unknown option "take" in "withCount\.commentCount"/],
    ["a missing relation", { commentCount: { where: {} } }, /"withCount\.commentCount" needs "relation"/],
    ["an empty relation", { commentCount: { relation: "" } }, /"withCount\.commentCount" needs "relation"/],
    ["a non-object where", { commentCount: { relation: "comments", where: "x" } }, /"where" in "withCount\.commentCount" must be a where clause/],
    ["an empty where array", { commentCount: { relation: "comments", where: [] } }, /"where" in "withCount\.commentCount" must be a where clause/],
    ["a non-boolean withDeleted", { commentCount: { relation: "comments", withDeleted: 1 } }, /"withDeleted" in "withCount\.commentCount" must be a boolean/],
  ])("rejects %s", (_, value, message) => {
    const error = captureError(() => parseWithCountOption(value));
    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toMatch(message);
  });

  it("names the relation path of a nested option", () => {
    const error = captureError(() => parseWithCountOption({ likeCount: 3 }, "posts.comments"));
    expect(error.message).toMatch(
      /"withCount\.likeCount" of relation "posts\.comments" in "relations" is number 3/,
    );
  });
});

describe("withCount under relations", () => {
  it("lands on the node it belongs to, at any depth", () => {
    const tree = parseRelationsOption({
      posts: {
        withCount: { commentCount: "comments" },
        relations: { comments: { withCount: { likeCount: { relation: "likes", withDeleted: true } } } },
      },
    })!;
    const posts = tree.nodes.get("posts")!;
    expect(posts.options?.withCount).toEqual([{ property: "commentCount", relation: "comments" }]);
    expect(posts.children?.nodes.get("comments")?.options?.withCount).toEqual([
      { property: "likeCount", relation: "likes", withDeleted: true },
    ]);
  });

  it("checks the shape with the node's path in the message", () => {
    const error = captureError(() =>
      parseRelationsOption({ posts: { relations: { comments: { withCount: ["likes"] } } } }),
    );
    expect(error.message).toMatch(/"withCount" of relation "posts\.comments" in "relations" must be an object/);
  });
});

class Like {
  id!: number;
}
class Comment {
  id!: number;
  approved!: boolean;
  likes!: Like[];
  likeCount?: number;
}
class Tag {
  id!: number;
  label!: string;
}
class User {
  id!: number;
  name!: string;
  posts!: Post[];
  postCount?: number;
}
class Post {
  id!: number;
  title!: string;
  views!: number;
  author!: User | null;
  comments!: Comment[];
  tags!: Promise<Tag[]>;
  commentCount?: number;
  approvedCount?: number | null;
  summary?: string;
}

describe("withCount typing", () => {
  it("collects the collection relations and the number properties", () => {
    type Collections = Expect<Equal<CollectionRelationKeys<Post>, "comments" | "tags">>;
    type Counts = Expect<Equal<CountPropertyKeys<Post>, "id" | "views" | "commentCount" | "approvedCount">>;
    const checks: [Collections, Counts] = [true, true];
    expect(checks).toEqual([true, true]);
  });

  it("types each count's where against the counted entity", () => {
    const ok: WithCountOption<Post> = {
      commentCount: "comments",
      approvedCount: { relation: "comments", where: { approved: true, likes: { some: {} } } },
    };
    const find: FindOption<Post> = { withCount: { commentCount: "tags" } };
    const nested: RelationsOption<User> = {
      posts: { withCount: { commentCount: "comments" }, relations: { comments: { withCount: { likeCount: "likes" } } } },
    };
    const toOne: RelationsOption<Post> = { author: { withCount: { postCount: "posts" } } };
    expect([ok, find, nested, toOne]).toHaveLength(4);
  });

  it("rejects a property that is not a number, a single-valued relation and a typo", () => {
    // @ts-expect-error — summary is a string property
    const text: WithCountOption<Post> = { summary: "comments" };
    // @ts-expect-error — author is single-valued
    const toOne: WithCountOption<Post> = { commentCount: "author" };
    // @ts-expect-error — "coments" is not a relation of Post
    const typo: WithCountOption<Post> = { commentCount: "coments" };
    // @ts-expect-error — "aproved" is not a property of Comment
    const where: WithCountOption<Post> = { approvedCount: { relation: "comments", where: { aproved: true } } };
    expect([text, toOne, typo, where]).toHaveLength(4);
  });
});
