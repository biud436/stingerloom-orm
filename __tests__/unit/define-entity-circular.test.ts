/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import * as path from "path";
import * as ts from "typescript";
import {
  defineEntity,
  t,
  InferEntity,
  AnyEntityClass,
} from "../../src/schema";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN } from "../../src/decorators/OneToMany";

/**
 * Mutual (circular) entity references with `defineEntity` (V3-T1-2).
 *
 * Two consts whose inferred types depend on each other cannot both be
 * inferred (TS7022) — an inherent TypeScript limitation, not an ORM bug.
 * The supported pattern breaks the cycle with three load-bearing pieces:
 *
 *   1. one side annotates its target thunk: `(): AnyEntityClass => Post`
 *      (stops the compiler from inferring the thunk's return type),
 *   2. that side passes the related row type explicitly: `t.oneToMany<Post>`,
 *   3. row types are declared by interface merging
 *      (`interface Post extends InferEntity<typeof Post> {}`) — interfaces
 *      resolve members lazily, `type` aliases are resolved eagerly.
 *
 * This file proves the pattern compiles under strict mode (the module itself
 * is type-checked by ts-jest), pins the runtime metadata it produces, and —
 * via an in-memory tsc program — pins that each piece is genuinely required.
 */

// ═══════════════════════════════════════════════════════════════════════════
// The documented pattern — compiling at all IS the primary assertion.
// ═══════════════════════════════════════════════════════════════════════════

const Author = defineEntity("dec_authors", {
  id: t.int().primary().generated(),
  name: t.varchar(120),
  posts: t.oneToMany<Post>((): AnyEntityClass => Post, "author"),
});
const Post = defineEntity("dec_posts", {
  id: t.int().primary().generated(),
  title: t.varchar(200),
  authorId: t.int().nullable().name("author_id"),
  author: t.manyToOne(() => Author, { joinColumn: "author_id" }),
});
interface Author extends InferEntity<typeof Author> {}
interface Post extends InferEntity<typeof Post> {}

// Many-to-many + one-to-one cycles use the same pattern.
const Student = defineEntity("dec_students", {
  id: t.int().primary().generated(),
  courses: t.manyToMany<Course>((): AnyEntityClass => Course),
});
const Course = defineEntity("dec_courses", {
  id: t.int().primary().generated(),
  students: t.manyToMany(() => Student, { mappedBy: "courses" }),
});
interface Student extends InferEntity<typeof Student> {}
interface Course extends InferEntity<typeof Course> {}

const User = defineEntity("dec_users", {
  id: t.int().primary().generated(),
  profile: t.oneToOne<Profile>((): AnyEntityClass => Profile),
});
const Profile = defineEntity("dec_profiles", {
  id: t.int().primary().generated(),
  userId: t.int().nullable().name("user_id"),
  user: t.oneToOne(() => User, { joinColumn: "user_id" }),
});
interface User extends InferEntity<typeof User> {}
interface Profile extends InferEntity<typeof Profile> {}

// ═══════════════════════════════════════════════════════════════════════════
// Type-level pins (checked when ts-jest compiles this file)
// ═══════════════════════════════════════════════════════════════════════════

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

// Both directions stay fully typed — no `any` leaks through the cycle.
type _authorPosts = Expect<Equal<Author["posts"], Post[] | undefined>>;
type _postAuthorName = Expect<
  Equal<NonNullable<Post["author"]>["name"], string>
>;
type _postAuthorId = Expect<Equal<Post["authorId"], number | null>>;

// The untouched inference form keeps its exact row types (no `S` pollution
// from the contextual `SchemaBuilder<any, any>` — guarded by `NoInfer`).
const Tag = defineEntity("dec_tags", {
  id: t.int().primary().generated(),
  label: t.varchar(64),
});
const TagLink = defineEntity("dec_tag_links", {
  id: t.int().primary().generated(),
  tag: t.manyToOne(() => Tag),
  tags: t.oneToMany(() => Tag, "label"),
  link: t.oneToOne(() => Tag),
  all: t.manyToMany(() => Tag),
});
type TagLink = InferEntity<typeof TagLink>;
type _tag = Expect<
  Equal<TagLink["tag"], { id: number; label: string } | undefined>
>;
type _tags = Expect<
  Equal<TagLink["tags"], { id: number; label: string }[] | undefined>
>;
type _link = Expect<
  Equal<TagLink["link"], { id: number; label: string } | undefined>
>;
type _all = Expect<
  Equal<TagLink["all"], { id: number; label: string }[] | undefined>
>;

describe("defineEntity — mutual references (documented pattern)", () => {
  it("walks the cycle with full typing at the value level", () => {
    const author: Author = new Author({ id: 1, name: "Ada" });
    const post: Post = new Post({
      id: 1,
      title: "Hello",
      authorId: 1,
      author,
    });
    author.posts = [post];

    // Deep circular navigation stays typed (string methods resolve).
    expect(author.posts?.[0]?.author?.name.toUpperCase()).toBe("ADA");
    expect(post.author?.posts?.[0]?.title.toLowerCase()).toBe("hello");
  });

  it("registers identical relation metadata for the explicit-shape form", () => {
    // oneToMany: the S-form call must be runtime-identical to the plain form.
    const o2m = Reflect.getMetadata(ONE_TO_MANY_TOKEN, Author);
    expect(o2m).toHaveLength(1);
    expect(o2m[0].propertyKey).toBe("posts");
    expect(o2m[0].mappedBy).toBe("author");
    expect(o2m[0].getRelatedEntity()).toBe(Post);

    const m2o = Reflect.getMetadata(MANY_TO_ONE_TOKEN, Post);
    expect(m2o).toHaveLength(1);
    expect(m2o[0].columnName).toBe("author");
    expect(m2o[0].getMappingEntity()).toBe(Author);
    expect(m2o[0].joinColumn).toBe("author_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Each piece of the pattern is load-bearing: compile probe variants with an
// in-memory tsc program against the real src/schema modules and pin their
// diagnostics. The "plain" variant is the fail-before reproduction — if a
// future TypeScript release makes it compile, this pin tells us the docs
// workaround can be retired.
// ═══════════════════════════════════════════════════════════════════════════

const ROOT = path.resolve(__dirname, "../..");
const VIRTUAL_DIR = path.join(ROOT, "__tests__/unit/__virtual__");

const IMPORTS = `import { defineEntity, t, InferEntity, AnyEntityClass } from "../../../src/schema";\n`;

/** README-style mutual reference with no cycle-breaking — inherent TS7022. */
const PLAIN = `${IMPORTS}
export const Author = defineEntity("authors", {
  id: t.int().primary().generated(),
  posts: t.oneToMany(() => Post, "author"),
});
export const Post = defineEntity("posts", {
  id: t.int().primary().generated(),
  author: t.manyToOne(() => Author, { joinColumn: "author_id" }),
});
export type Author = InferEntity<typeof Author>;
export type Post = InferEntity<typeof Post>;
`;

/** Explicit shape but unannotated thunk — the thunk body re-enters the cycle. */
const NO_ANNOTATION = `${IMPORTS}
export const Author = defineEntity("authors", {
  id: t.int().primary().generated(),
  posts: t.oneToMany<Post>(() => Post, "author"),
});
export const Post = defineEntity("posts", {
  id: t.int().primary().generated(),
  author: t.manyToOne(() => Author, { joinColumn: "author_id" }),
});
export interface Author extends InferEntity<typeof Author> {}
export interface Post extends InferEntity<typeof Post> {}
`;

/** `type` aliases instead of interfaces — aliases resolve eagerly. */
const TYPE_ALIAS = `${IMPORTS}
export const Author = defineEntity("authors", {
  id: t.int().primary().generated(),
  posts: t.oneToMany<Post>((): AnyEntityClass => Post, "author"),
});
export const Post = defineEntity("posts", {
  id: t.int().primary().generated(),
  author: t.manyToOne(() => Author, { joinColumn: "author_id" }),
});
export type Author = InferEntity<typeof Author>;
export type Post = InferEntity<typeof Post>;
`;

/** The full documented pattern — must compile clean. */
const FULL_PATTERN = `${IMPORTS}
export const Author = defineEntity("authors", {
  id: t.int().primary().generated(),
  posts: t.oneToMany<Post>((): AnyEntityClass => Post, "author"),
});
export const Post = defineEntity("posts", {
  id: t.int().primary().generated(),
  author: t.manyToOne(() => Author, { joinColumn: "author_id" }),
});
export interface Author extends InferEntity<typeof Author> {}
export interface Post extends InferEntity<typeof Post> {}
`;

const PROBES: Record<string, string> = {
  "plain.ts": PLAIN,
  "no-annotation.ts": NO_ANNOTATION,
  "type-alias.ts": TYPE_ALIAS,
  "full-pattern.ts": FULL_PATTERN,
};

function compileProbes(): Record<string, number[]> {
  const configPath = path.join(ROOT, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
  };

  const virtualPaths = Object.keys(PROBES).map((name) =>
    path.join(VIRTUAL_DIR, name),
  );
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const virtual = new Map(
    Object.entries(PROBES).map(([name, text]) => [
      path.join(VIRTUAL_DIR, name),
      text,
    ]),
  );
  host.fileExists = (f) => virtual.has(f) || baseFileExists(f);
  host.readFile = (f) => virtual.get(f) ?? baseReadFile(f);
  host.getSourceFile = (f, languageVersion, ...rest) => {
    const text = virtual.get(f);
    if (text !== undefined) {
      return ts.createSourceFile(f, text, languageVersion, true);
    }
    return baseGetSourceFile(f, languageVersion, ...rest);
  };

  const program = ts.createProgram(virtualPaths, options, host);
  const result: Record<string, number[]> = {};
  for (const [name] of Object.entries(PROBES)) {
    const source = program.getSourceFile(path.join(VIRTUAL_DIR, name));
    if (!source) throw new Error(`probe not in program: ${name}`);
    result[name] = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ].map((d) => d.code);
  }
  return result;
}

describe("defineEntity — mutual references (each piece is load-bearing)", () => {
  let diagnostics: Record<string, number[]>;

  beforeAll(() => {
    diagnostics = compileProbes();
  });

  it("plain mutual reference does not compile (TS7022 — fail-before pin)", () => {
    expect(diagnostics["plain.ts"]).toContain(7022);
  });

  it("explicit shape without the thunk annotation still cycles (TS7022)", () => {
    expect(diagnostics["no-annotation.ts"]).toContain(7022);
  });

  it("`type` aliases instead of interface merging still cycle (TS7022)", () => {
    expect(diagnostics["type-alias.ts"]).toContain(7022);
  });

  it("the full documented pattern compiles with zero diagnostics", () => {
    expect(diagnostics["full-pattern.ts"]).toEqual([]);
  });
});
