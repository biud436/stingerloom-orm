/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  snapshotCollections,
  diffCollection,
  resolveFkColumn,
  CollectionSnapshot,
} from "../../src/core/plugin/buffer/CollectionTracker";
import { ONE_TO_MANY_TOKEN } from "../../src/decorators/OneToMany";
import { MANY_TO_MANY_TOKEN } from "../../src/decorators/ManyToMany";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";

// ── Test Entity Definitions ─────────────────────────────────────

class Comment {
  id!: number;
  body!: string;
  postId!: number;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Comment", tableName: "comments" }, Comment);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Comment, name: "id", propertyKey: "id", type: Number, options: { primary: true } },
    { target: Comment, name: "body", propertyKey: "body", type: String, options: {} },
    { target: Comment, name: "postId", propertyKey: "postId", type: Number, options: {} },
  ],
  Comment.prototype,
);

class Tag {
  id!: number;
  label!: string;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Tag", tableName: "tags" }, Tag);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Tag, name: "id", propertyKey: "id", type: Number, options: { primary: true } },
    { target: Tag, name: "label", propertyKey: "label", type: String, options: {} },
  ],
  Tag.prototype,
);

class Post {
  id!: number;
  title!: string;
  comments!: Comment[];
  tags!: Tag[];
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Post", tableName: "posts" }, Post);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Post, name: "id", propertyKey: "id", type: Number, options: { primary: true } },
    { target: Post, name: "title", propertyKey: "title", type: String, options: {} },
  ],
  Post.prototype,
);

// @OneToMany(() => Comment, { mappedBy: "post", cascade: ["insert", "update"] })
Reflect.defineMetadata(
  ONE_TO_MANY_TOKEN,
  [{
    target: Post,
    propertyKey: "comments",
    getRelatedEntity: () => Comment,
    mappedBy: "post",
    cascade: ["insert", "update"],
  }],
  Post,
);

// @ManyToMany(() => Tag, { joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" } })
Reflect.defineMetadata(
  MANY_TO_MANY_TOKEN,
  [{
    target: Post,
    propertyKey: "tags",
    getRelatedEntity: () => Tag,
    joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  }],
  Post,
);

// @ManyToOne on Comment pointing to Post (FK resolution)
Reflect.defineMetadata(
  MANY_TO_ONE_TOKEN,
  [{
    target: Comment,
    type: Post,
    columnName: "post",
    joinColumn: "postId",
    getMappingEntity: () => Post,
    getMappingProperty: (e: any) => e.post,
    option: {},
  }],
  Comment,
);

// Tag inverse side (mappedBy, no joinTable) — should be skipped
Reflect.defineMetadata(
  MANY_TO_MANY_TOKEN,
  [{
    target: Tag,
    propertyKey: "posts",
    getRelatedEntity: () => Post,
    mappedBy: "tags",
  }],
  Tag,
);

// ── Entity with no relations ────────────────────────────────────

class Standalone {
  id!: number;
  value!: string;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Standalone", tableName: "standalone" }, Standalone);

// ── Tests ────────────────────────────────────────────────────────

describe("CollectionTracker", () => {

  // ── snapshotCollections ──────────────────────────────────────

  describe("snapshotCollections()", () => {
    it("should capture OneToMany arrays", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "hi" });
      const c2 = Object.assign(new Comment(), { id: 2, body: "hello" });
      const post = Object.assign(new Post(), { id: 1, title: "Test", comments: [c1, c2], tags: [] });

      const snapshots = snapshotCollections(post, Post);
      const o2m = snapshots.find(s => s.relationType === "oneToMany");
      expect(o2m).toBeDefined();
      expect(o2m!.propertyKey).toBe("comments");
      expect(o2m!.originalItems.size).toBe(2);
      expect(o2m!.originalItems.has(c1)).toBe(true);
      expect(o2m!.originalItems.has(c2)).toBe(true);
      expect(o2m!.relatedEntity).toBe(Comment);
      expect(o2m!.fkColumn).toBe("postId");
      expect(o2m!.mappedBy).toBe("post");
      expect(o2m!.cascade).toEqual(["insert", "update"]);
    });

    it("should capture ManyToMany owning-side arrays", () => {
      const t1 = Object.assign(new Tag(), { id: 1, label: "ts" });
      const post = Object.assign(new Post(), { id: 1, title: "Test", comments: [], tags: [t1] });

      const snapshots = snapshotCollections(post, Post);
      const m2m = snapshots.find(s => s.relationType === "manyToMany");
      expect(m2m).toBeDefined();
      expect(m2m!.propertyKey).toBe("tags");
      expect(m2m!.originalItems.size).toBe(1);
      expect(m2m!.relatedEntity).toBe(Tag);
      expect(m2m!.joinTable).toEqual({
        name: "post_tags",
        joinColumn: "post_id",
        inverseJoinColumn: "tag_id",
      });
    });

    it("should skip inverse ManyToMany (has mappedBy, no joinTable)", () => {
      const tag = Object.assign(new Tag(), { id: 1, label: "ts", posts: [{ id: 1 }] });
      const snapshots = snapshotCollections(tag, Tag);
      // Tag's M2M has mappedBy — should be skipped
      expect(snapshots.filter(s => s.relationType === "manyToMany")).toHaveLength(0);
    });

    it("should skip non-array relation properties", () => {
      const post = Object.assign(new Post(), { id: 1, title: "Test", comments: null, tags: "not an array" });
      const snapshots = snapshotCollections(post, Post);
      expect(snapshots).toHaveLength(0);
    });

    it("should return empty array for entities with no relations", () => {
      const standalone = Object.assign(new Standalone(), { id: 1, value: "x" });
      const snapshots = snapshotCollections(standalone, Standalone);
      expect(snapshots).toEqual([]);
    });

    it("should capture both O2M and M2M in a single call", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a" });
      const t1 = Object.assign(new Tag(), { id: 1, label: "b" });
      const post = Object.assign(new Post(), { id: 1, title: "Test", comments: [c1], tags: [t1] });

      const snapshots = snapshotCollections(post, Post);
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map(s => s.relationType).sort()).toEqual(["manyToMany", "oneToMany"]);
    });
  });

  // ── diffCollection ──────────────────────────────────────────

  describe("diffCollection()", () => {
    it("should detect added items", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a" });
      const c2 = Object.assign(new Comment(), { id: 2, body: "b" });

      const snapshot: CollectionSnapshot = {
        propertyKey: "comments",
        relationType: "oneToMany",
        originalItems: new Set([c1]),
        relatedEntity: Comment,
        fkColumn: "postId",
      };

      const instance = { comments: [c1, c2] };
      const diff = diffCollection(instance, snapshot);
      expect(diff).not.toBeNull();
      expect(diff!.added).toEqual([c2]);
      expect(diff!.removed).toEqual([]);
    });

    it("should detect removed items", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a" });
      const c2 = Object.assign(new Comment(), { id: 2, body: "b" });

      const snapshot: CollectionSnapshot = {
        propertyKey: "comments",
        relationType: "oneToMany",
        originalItems: new Set([c1, c2]),
        relatedEntity: Comment,
        fkColumn: "postId",
      };

      const instance = { comments: [c1] };
      const diff = diffCollection(instance, snapshot);
      expect(diff).not.toBeNull();
      expect(diff!.added).toEqual([]);
      expect(diff!.removed).toEqual([c2]);
    });

    it("should return null when collection is unchanged", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a" });

      const snapshot: CollectionSnapshot = {
        propertyKey: "comments",
        relationType: "oneToMany",
        originalItems: new Set([c1]),
        relatedEntity: Comment,
        fkColumn: "postId",
      };

      const instance = { comments: [c1] };
      expect(diffCollection(instance, snapshot)).toBeNull();
    });

    it("should treat removed collection (non-array) as all items removed", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a" });

      const snapshot: CollectionSnapshot = {
        propertyKey: "comments",
        relationType: "oneToMany",
        originalItems: new Set([c1]),
        relatedEntity: Comment,
        fkColumn: "postId",
      };

      const instance = { comments: undefined };
      const diff = diffCollection(instance, snapshot);
      expect(diff).not.toBeNull();
      expect(diff!.added).toEqual([]);
      expect(diff!.removed).toEqual([c1]);
    });

    it("should return null when collection was empty and is now removed", () => {
      const snapshot: CollectionSnapshot = {
        propertyKey: "comments",
        relationType: "oneToMany",
        originalItems: new Set(),
        relatedEntity: Comment,
        fkColumn: "postId",
      };

      const instance = { comments: null };
      expect(diffCollection(instance, snapshot)).toBeNull();
    });

    it("should detect both additions and removals simultaneously", () => {
      const c1 = Object.assign(new Comment(), { id: 1, body: "a" });
      const c2 = Object.assign(new Comment(), { id: 2, body: "b" });
      const c3 = Object.assign(new Comment(), { id: 3, body: "c" });

      const snapshot: CollectionSnapshot = {
        propertyKey: "comments",
        relationType: "oneToMany",
        originalItems: new Set([c1, c2]),
        relatedEntity: Comment,
        fkColumn: "postId",
      };

      const instance = { comments: [c2, c3] };
      const diff = diffCollection(instance, snapshot);
      expect(diff).not.toBeNull();
      expect(diff!.added).toEqual([c3]);
      expect(diff!.removed).toEqual([c1]);
    });
  });

  // ── resolveFkColumn ─────────────────────────────────────────

  describe("resolveFkColumn()", () => {
    it("should resolve joinColumn from ManyToOne metadata", () => {
      const rel = {
        target: Post,
        propertyKey: "comments",
        getRelatedEntity: () => Comment,
        mappedBy: "post",
      };

      const fk = resolveFkColumn(rel as any, Comment);
      expect(fk).toBe("postId");
    });

    it("should fall back to mappedBy when no ManyToOne match is found", () => {
      // Entity with no MANY_TO_ONE_TOKEN metadata
      class Orphan {
        id!: number;
      }

      const rel = {
        target: Post,
        propertyKey: "orphans",
        getRelatedEntity: () => Orphan,
        mappedBy: "parentId",
      };

      const fk = resolveFkColumn(rel as any, Orphan);
      expect(fk).toBe("parentId");
    });

    it("should fall back to mappedBy when M2O exists but columnName does not match", () => {
      // Comment has M2O with columnName "post", but if we query with mappedBy "author"
      // it should not match and fall back
      const rel = {
        target: Post,
        propertyKey: "comments",
        getRelatedEntity: () => Comment,
        mappedBy: "author", // does not match Comment's M2O columnName "post"
      };

      const fk = resolveFkColumn(rel as any, Comment);
      expect(fk).toBe("author");
    });
  });
});
