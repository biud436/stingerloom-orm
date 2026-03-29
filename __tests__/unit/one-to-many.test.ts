import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { OneToMany, ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../src/decorators/OneToMany";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToManyScanner } from "../../src/scanner/OneToManyScanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe("@OneToMany decorator", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should store metadata via Reflect.defineMetadata with ONE_TO_MANY_TOKEN", () => {
    class Post {
      userId!: number;
    }

    class User {
      @OneToMany(() => Post, { mappedBy: "userId" })
      posts!: Post[];
    }

    const metadata: OneToManyMetadata<Post>[] = Reflect.getMetadata(
      ONE_TO_MANY_TOKEN,
      User,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].target).toBe(User);
    expect(metadata[0].propertyKey).toBe("posts");
    expect(metadata[0].mappedBy).toBe("userId");
    expect(metadata[0].getRelatedEntity()).toBe(Post);
  });

  it("should support multiple @OneToMany decorators on the same entity", () => {
    class Post {}
    class Comment {}

    class User {
      @OneToMany(() => Post, { mappedBy: "author" })
      posts!: Post[];

      @OneToMany(() => Comment, { mappedBy: "author" })
      comments!: Comment[];
    }

    const metadata: OneToManyMetadata<unknown>[] = Reflect.getMetadata(
      ONE_TO_MANY_TOKEN,
      User,
    );

    expect(metadata).toHaveLength(2);

    const postsMeta = metadata.find((m) => m.propertyKey === "posts");
    const commentsMeta = metadata.find((m) => m.propertyKey === "comments");

    expect(postsMeta).toBeDefined();
    expect(postsMeta!.getRelatedEntity()).toBe(Post);
    expect(postsMeta!.mappedBy).toBe("author");

    expect(commentsMeta).toBeDefined();
    expect(commentsMeta!.getRelatedEntity()).toBe(Comment);
    expect(commentsMeta!.mappedBy).toBe("author");
  });

  it("should set target to the constructor of the decorated class", () => {
    class Item {}

    class Order {
      @OneToMany(() => Item, { mappedBy: "order" })
      items!: Item[];
    }

    const metadata: OneToManyMetadata<Item>[] = Reflect.getMetadata(
      ONE_TO_MANY_TOKEN,
      Order,
    );

    expect(metadata[0].target).toBe(Order);
  });
});

describe("OneToManyScanner", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should register metadata in the scanner via the decorator", () => {
    class Comment {}

    class Post {
      @OneToMany(() => Comment, { mappedBy: "post" })
      comments!: Comment[];
    }

    const scanner = getScannerInstance(OneToManyScanner);
    const results = scanner.scan(Post);

    expect(results).toHaveLength(1);
    expect(results[0].target).toBe(Post);
    expect(results[0].propertyKey).toBe("comments");
    expect(results[0].mappedBy).toBe("post");
    expect(results[0].getRelatedEntity()).toBe(Comment);
  });

  it("should iterate over all OneToMany metadata via makeOneToManys", () => {
    class Post {}
    class Comment {}

    class User {
      @OneToMany(() => Post, { mappedBy: "user" })
      posts!: Post[];

      @OneToMany(() => Comment, { mappedBy: "user" })
      comments!: Comment[];
    }

    const scanner = getScannerInstance(OneToManyScanner);
    const allMeta = [...scanner.makeOneToManys()];

    expect(allMeta).toHaveLength(2);
    expect(allMeta.map((m) => m.propertyKey)).toContain("posts");
    expect(allMeta.map((m) => m.propertyKey)).toContain("comments");
  });

  it("should return empty array when scanning entity with no @OneToMany", () => {
    class PlainEntity {}

    const scanner = getScannerInstance(OneToManyScanner);
    const results = scanner.scan(PlainEntity);

    expect(results).toHaveLength(0);
  });

  it("should use layered metadata store and support context switching", () => {
    const scanner = getScannerInstance(OneToManyScanner);

    // Register in public context
    scanner.switchContext("public");
    scanner.set("publicRelation", {
      target: class A {},
      propertyKey: "items",
      getRelatedEntity: () => class B {},
      mappedBy: "parent",
    });

    // Register in tenant_1 context
    scanner.switchContext("tenant_1");
    scanner.set("tenantRelation", {
      target: class C {},
      propertyKey: "children",
      getRelatedEntity: () => class D {},
      mappedBy: "owner",
    });

    // tenant_1 should see its own + public metadata
    const tenantMeta = scanner.allMetadata();
    expect(tenantMeta.length).toBeGreaterThanOrEqual(1);

    const tenantEntry = tenantMeta.find(
      (m: any) => m.propertyKey === "children",
    );
    expect(tenantEntry).toBeDefined();

    // Switch back to public: should only see public metadata
    scanner.switchContext("public");
    const publicMeta = scanner.allMetadata();
    const publicEntry = publicMeta.find(
      (m: any) => m.propertyKey === "items",
    );
    expect(publicEntry).toBeDefined();

    // tenant-only entry should not be in public context
    const tenantOnlyInPublic = publicMeta.find(
      (m: any) => m.propertyKey === "children",
    );
    expect(tenantOnlyInPublic).toBeUndefined();
  });
});

describe("@OneToMany and @ManyToOne bidirectional", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should allow bidirectional relationship setup", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    class Post {
      @ManyToOne(
        () => User,
        (entity: any) => entity.user,
      )
      user!: any;
    }

    class User {
      @OneToMany(() => Post, { mappedBy: "user" })
      posts!: Post[];
    }

    // Verify OneToMany metadata on User
    const oneToManyMeta: OneToManyMetadata<Post>[] = Reflect.getMetadata(
      ONE_TO_MANY_TOKEN,
      User,
    );
    expect(oneToManyMeta).toHaveLength(1);
    expect(oneToManyMeta[0].propertyKey).toBe("posts");
    expect(oneToManyMeta[0].mappedBy).toBe("user");
    expect(oneToManyMeta[0].getRelatedEntity()).toBe(Post);
  });
});
