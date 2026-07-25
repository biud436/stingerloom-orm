/**
 * joinTable option validation for ManyToMany relations.
 *
 * TypeScript rejects malformed JoinTableOption values at compile time, but
 * plain-JavaScript consumers can pass `joinTable: true` or a partial object.
 * Without registration-time validation that surfaced as a cryptic
 * `Cannot read properties of undefined (reading 'replace')` inside schema
 * sync — both the decorator and the defineEntity bridge must fail fast with
 * a clear OrmError instead.
 */
import "reflect-metadata";
import { ManyToMany, validateJoinTableOption } from "../../src/decorators/ManyToMany";
import { defineEntity, t } from "../../src/schema";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ManyToManyScanner } from "../../src/scanner";

afterEach(() => {
  getScannerInstance(ManyToManyScanner).clear();
});

describe("validateJoinTableOption", () => {
  it("accepts undefined / null (inverse side)", () => {
    expect(() => validateJoinTableOption(undefined, "Tag", "posts")).not.toThrow();
    expect(() => validateJoinTableOption(null, "Tag", "posts")).not.toThrow();
  });

  it("accepts a fully specified option", () => {
    expect(() =>
      validateJoinTableOption(
        { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
        "Tag",
        "posts",
      ),
    ).not.toThrow();
  });

  it.each([
    ["boolean true", true],
    ["empty object", {}],
    ["missing inverseJoinColumn", { name: "post_tags", joinColumn: "post_id" }],
    ["empty name", { name: "", joinColumn: "a", inverseJoinColumn: "b" }],
    ["string", "post_tags"],
  ])("rejects %s with a SCHEMA_ERROR naming the property", (_label, value) => {
    let caught: unknown;
    try {
      validateJoinTableOption(value, "Tag", "posts");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect((caught as OrmError).message).toContain("Tag.posts");
    expect((caught as OrmError).suggestion).toContain("inverseJoinColumn");
  });
});

describe("@ManyToMany decorator validation", () => {
  it("throws at decoration time for joinTable: true", () => {
    class Post {}
    class Tag {}
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ManyToMany(() => Post, { joinTable: true as any })(Tag.prototype, "posts"),
    ).toThrow(OrmError);
  });

  it("accepts a valid joinTable and the inverse side (mappedBy)", () => {
    class Post {}
    class Tag {}
    expect(() =>
      ManyToMany(() => Tag, {
        joinTable: { name: "p_t", joinColumn: "p_id", inverseJoinColumn: "t_id" },
      })(Post.prototype, "tags"),
    ).not.toThrow();
    expect(() =>
      ManyToMany(() => Post, { mappedBy: "tags" })(Tag.prototype, "posts"),
    ).not.toThrow();
  });
});

describe("defineEntity t.manyToMany validation", () => {
  it("throws at definition time for a malformed joinTable", () => {
    const Post = defineEntity("m2m_val_posts", {
      id: t.int().primary().generated(),
    });
    expect(() =>
      defineEntity("m2m_val_tags", {
        id: t.int().primary().generated(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        posts: t.manyToMany(() => Post, { joinTable: true as any }),
      }),
    ).toThrow(/Invalid joinTable option on m2m_val_tags.posts/);
  });

  it("accepts a fully specified joinTable", () => {
    const Post = defineEntity("m2m_ok_posts", {
      id: t.int().primary().generated(),
    });
    expect(() =>
      defineEntity("m2m_ok_tags", {
        id: t.int().primary().generated(),
        posts: t.manyToMany(() => Post, {
          joinTable: {
            name: "m2m_ok_post_tags",
            joinColumn: "tag_id",
            inverseJoinColumn: "post_id",
          },
        }),
      }),
    ).not.toThrow();
  });
});
