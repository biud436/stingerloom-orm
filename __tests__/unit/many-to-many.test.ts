import "reflect-metadata";
import Container from "typedi";
import {
  ManyToMany,
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  ManyToManyOption,
  JoinTableOption,
} from "../../src/decorators/ManyToMany";
import { ManyToManyScanner } from "../../src/scanner/ManyToManyScanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe("@ManyToMany decorator", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
  });

  it("should store metadata with joinTable option (owning side)", () => {
    class Tag {}

    class Post {
      @ManyToMany(() => Tag, {
        joinTable: {
          name: "post_tags",
          joinColumn: "post_id",
          inverseJoinColumn: "tag_id",
        },
      })
      tags!: Tag[];
    }

    const metadata: ManyToManyMetadata<Tag>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      Post,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].target).toBe(Post);
    expect(metadata[0].propertyKey).toBe("tags");
    expect(metadata[0].getRelatedEntity()).toBe(Tag);
    expect(metadata[0].joinTable).toEqual({
      name: "post_tags",
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    });
    expect(metadata[0].mappedBy).toBeUndefined();
  });

  it("should store metadata with mappedBy option (inverse side)", () => {
    class Post {}

    class Tag {
      @ManyToMany(() => Post, { mappedBy: "tags" })
      posts!: Post[];
    }

    const metadata: ManyToManyMetadata<Post>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      Tag,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].target).toBe(Tag);
    expect(metadata[0].propertyKey).toBe("posts");
    expect(metadata[0].mappedBy).toBe("tags");
    expect(metadata[0].joinTable).toBeUndefined();
  });

  it("should store metadata without any options", () => {
    class Role {}

    class User {
      @ManyToMany(() => Role)
      roles!: Role[];
    }

    const metadata: ManyToManyMetadata<Role>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      User,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].target).toBe(User);
    expect(metadata[0].propertyKey).toBe("roles");
    expect(metadata[0].joinTable).toBeUndefined();
    expect(metadata[0].mappedBy).toBeUndefined();
  });

  it("should support multiple @ManyToMany on the same entity", () => {
    class Tag {}
    class Category {}

    class Article {
      @ManyToMany(() => Tag, {
        joinTable: {
          name: "article_tags",
          joinColumn: "article_id",
          inverseJoinColumn: "tag_id",
        },
      })
      tags!: Tag[];

      @ManyToMany(() => Category, {
        joinTable: {
          name: "article_categories",
          joinColumn: "article_id",
          inverseJoinColumn: "category_id",
        },
      })
      categories!: Category[];
    }

    const metadata: ManyToManyMetadata<unknown>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      Article,
    );

    expect(metadata).toHaveLength(2);

    const tagsMeta = metadata.find((m) => m.propertyKey === "tags");
    const categoriesMeta = metadata.find(
      (m) => m.propertyKey === "categories",
    );

    expect(tagsMeta!.joinTable!.name).toBe("article_tags");
    expect(categoriesMeta!.joinTable!.name).toBe("article_categories");
  });
});

describe("ManyToManyScanner", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
  });

  it("should register metadata in the scanner via the decorator", () => {
    class Permission {}

    class Role {
      @ManyToMany(() => Permission, {
        joinTable: {
          name: "role_permissions",
          joinColumn: "role_id",
          inverseJoinColumn: "permission_id",
        },
      })
      permissions!: Permission[];
    }

    const scanner = Container.get(ManyToManyScanner);
    const results = scanner.scan(Role);

    expect(results).toHaveLength(1);
    expect(results[0].target).toBe(Role);
    expect(results[0].propertyKey).toBe("permissions");
    expect(results[0].joinTable!.name).toBe("role_permissions");
  });

  it("should iterate all metadata via makeManyToManys", () => {
    class Tag {}
    class Category {}

    class Post {
      @ManyToMany(() => Tag, {
        joinTable: {
          name: "post_tags",
          joinColumn: "post_id",
          inverseJoinColumn: "tag_id",
        },
      })
      tags!: Tag[];

      @ManyToMany(() => Category, {
        joinTable: {
          name: "post_categories",
          joinColumn: "post_id",
          inverseJoinColumn: "category_id",
        },
      })
      categories!: Category[];
    }

    const scanner = Container.get(ManyToManyScanner);
    const allMeta = [...scanner.makeManyToManys()];

    expect(allMeta).toHaveLength(2);
    expect(allMeta.map((m) => m.propertyKey)).toContain("tags");
    expect(allMeta.map((m) => m.propertyKey)).toContain("categories");
  });

  it("should return empty array when scanning entity with no @ManyToMany", () => {
    class PlainEntity {}

    const scanner = Container.get(ManyToManyScanner);
    const results = scanner.scan(PlainEntity);

    expect(results).toHaveLength(0);
  });

  it("should support layered metadata context switching", () => {
    const scanner = Container.get(ManyToManyScanner);

    // Register in public context
    scanner.switchContext("public");
    scanner.set("publicRelation", {
      target: class A {},
      propertyKey: "items",
      getRelatedEntity: () => class B {},
      joinTable: { name: "a_b", joinColumn: "a_id", inverseJoinColumn: "b_id" },
    });

    // Register in tenant_1 context
    scanner.switchContext("tenant_1");
    scanner.set("tenantRelation", {
      target: class C {},
      propertyKey: "children",
      getRelatedEntity: () => class D {},
      joinTable: { name: "c_d", joinColumn: "c_id", inverseJoinColumn: "d_id" },
    });

    // tenant_1 should see its own + public metadata
    const tenantMeta = scanner.allMetadata();
    const tenantEntry = tenantMeta.find(
      (m: any) => m.propertyKey === "children",
    );
    expect(tenantEntry).toBeDefined();

    // Switch back to public: should not see tenant-only entry
    scanner.switchContext("public");
    const publicMeta = scanner.allMetadata();
    const tenantOnlyInPublic = publicMeta.find(
      (m: any) => m.propertyKey === "children",
    );
    expect(tenantOnlyInPublic).toBeUndefined();
  });
});

describe("@ManyToMany bidirectional", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
  });

  it("should support bidirectional ManyToMany with joinTable and mappedBy", () => {
    class Tag {
      @ManyToMany(() => Post, { mappedBy: "tags" })
      posts!: Post[];
    }

    class Post {
      @ManyToMany(() => Tag, {
        joinTable: {
          name: "post_tags",
          joinColumn: "post_id",
          inverseJoinColumn: "tag_id",
        },
      })
      tags!: Tag[];
    }

    // Owning side (Post.tags)
    const postMeta: ManyToManyMetadata<Tag>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      Post,
    );
    expect(postMeta).toHaveLength(1);
    expect(postMeta[0].joinTable!.name).toBe("post_tags");
    expect(postMeta[0].joinTable!.joinColumn).toBe("post_id");
    expect(postMeta[0].joinTable!.inverseJoinColumn).toBe("tag_id");

    // Inverse side (Tag.posts)
    const tagMeta: ManyToManyMetadata<Post>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      Tag,
    );
    expect(tagMeta).toHaveLength(1);
    expect(tagMeta[0].mappedBy).toBe("tags");
    expect(tagMeta[0].joinTable).toBeUndefined();
  });
});

describe("ManyToManyOption / JoinTableOption types", () => {
  it("should accept JoinTableOption with all required fields", () => {
    const joinTable: JoinTableOption = {
      name: "user_roles",
      joinColumn: "user_id",
      inverseJoinColumn: "role_id",
    };
    expect(joinTable.name).toBe("user_roles");
    expect(joinTable.joinColumn).toBe("user_id");
    expect(joinTable.inverseJoinColumn).toBe("role_id");
  });

  it("should accept ManyToManyOption with joinTable", () => {
    const option: ManyToManyOption = {
      joinTable: {
        name: "student_courses",
        joinColumn: "student_id",
        inverseJoinColumn: "course_id",
      },
    };
    expect(option.joinTable).toBeDefined();
    expect(option.mappedBy).toBeUndefined();
  });

  it("should accept ManyToManyOption with mappedBy", () => {
    const option: ManyToManyOption = {
      mappedBy: "students",
    };
    expect(option.mappedBy).toBe("students");
    expect(option.joinTable).toBeUndefined();
  });
});
