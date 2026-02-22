import "reflect-metadata";
import Container from "typedi";
import {
  OneToMany,
  ONE_TO_MANY_TOKEN,
  OneToManyMetadata,
} from "../../src/decorators/OneToMany";
import {
  ManyToOne,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
} from "../../src/decorators/ManyToOne";
import { OneToManyScanner } from "../../src/scanner/OneToManyScanner";
import { ManyToOneScanner } from "../../src/scanner/ManyToOneScanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import {
  CascadeType,
  CascadeOption,
  normalizeCascade,
  hasCascade,
} from "../../src/types/CascadeType";

describe("Cascade 옵션", () => {
  describe("CascadeType 타입 정의", () => {
    it("insert, update, delete, remove 타입을 허용해야 한다", () => {
      const types: CascadeType[] = ["insert", "update", "delete", "remove"];
      expect(types).toHaveLength(4);
    });

    it("cascade 배열은 부분 집합도 허용해야 한다", () => {
      const insertOnly: CascadeType[] = ["insert"];
      const deleteOnly: CascadeType[] = ["delete"];
      expect(insertOnly).toEqual(["insert"]);
      expect(deleteOnly).toEqual(["delete"]);
    });
  });

  describe("normalizeCascade", () => {
    it("true를 ['insert', 'update', 'delete']로 정규화해야 한다", () => {
      expect(normalizeCascade(true)).toEqual(["insert", "update", "delete"]);
    });

    it("false를 빈 배열로 정규화해야 한다", () => {
      expect(normalizeCascade(false)).toEqual([]);
    });

    it("undefined를 빈 배열로 정규화해야 한다", () => {
      expect(normalizeCascade(undefined)).toEqual([]);
    });

    it("배열을 그대로 반환해야 한다", () => {
      expect(normalizeCascade(["insert", "delete"])).toEqual([
        "insert",
        "delete",
      ]);
    });

    it('"remove"를 "delete"로 정규화해야 한다', () => {
      expect(normalizeCascade(["insert", "remove"])).toEqual([
        "insert",
        "delete",
      ]);
    });

    it("빈 배열을 그대로 반환해야 한다", () => {
      expect(normalizeCascade([])).toEqual([]);
    });
  });

  describe("hasCascade", () => {
    it("배열에 포함된 타입을 감지해야 한다", () => {
      expect(hasCascade(["insert", "update"], "insert")).toBe(true);
      expect(hasCascade(["insert", "update"], "update")).toBe(true);
      expect(hasCascade(["insert", "update"], "delete")).toBe(false);
    });

    it("true일 때 모든 타입을 포함해야 한다", () => {
      expect(hasCascade(true, "insert")).toBe(true);
      expect(hasCascade(true, "update")).toBe(true);
      expect(hasCascade(true, "delete")).toBe(true);
    });

    it("false/undefined일 때 어떤 타입도 포함하지 않아야 한다", () => {
      expect(hasCascade(false, "insert")).toBe(false);
      expect(hasCascade(undefined, "insert")).toBe(false);
      expect(hasCascade(undefined, "delete")).toBe(false);
    });

    it('"delete"와 "remove"를 동일하게 취급해야 한다', () => {
      expect(hasCascade(["remove"], "delete")).toBe(true);
      expect(hasCascade(["delete"], "remove")).toBe(true);
      expect(hasCascade(["remove"], "remove")).toBe(true);
    });
  });

  describe("@OneToMany cascade 데코레이터 통합", () => {
    beforeEach(() => {
      MetadataLayerRegistry.reset();
      Container.reset();
    });

    it("cascade 배열이 메타데이터에 저장되어야 한다", () => {
      class Post {
        userId!: number;
      }

      class User {
        @OneToMany(() => Post, {
          mappedBy: "userId",
          cascade: ["insert", "update", "delete"],
        })
        posts!: Post[];
      }

      const metadata: OneToManyMetadata<Post>[] = Reflect.getMetadata(
        ONE_TO_MANY_TOKEN,
        User,
      );

      expect(metadata).toBeDefined();
      expect(metadata).toHaveLength(1);
      expect(metadata[0].cascade).toEqual(["insert", "update", "delete"]);
    });

    it("cascade: true가 메타데이터에 저장되어야 한다", () => {
      class Post {
        userId!: number;
      }

      class User {
        @OneToMany(() => Post, {
          mappedBy: "userId",
          cascade: true,
        })
        posts!: Post[];
      }

      const metadata: OneToManyMetadata<Post>[] = Reflect.getMetadata(
        ONE_TO_MANY_TOKEN,
        User,
      );

      expect(metadata[0].cascade).toBe(true);
    });

    it("cascade 옵션 없이 사용할 수 있어야 한다", () => {
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

      expect(metadata[0].cascade).toBeUndefined();
    });

    it("cascade: ['insert'] 만 설정할 수 있어야 한다", () => {
      class Comment {
        postId!: number;
      }

      class Post {
        @OneToMany(() => Comment, {
          mappedBy: "postId",
          cascade: ["insert"],
        })
        comments!: Comment[];
      }

      const metadata: OneToManyMetadata<Comment>[] = Reflect.getMetadata(
        ONE_TO_MANY_TOKEN,
        Post,
      );

      expect(metadata[0].cascade).toEqual(["insert"]);
    });

    it("cascade: ['delete'] 만 설정할 수 있어야 한다", () => {
      class Item {
        orderId!: number;
      }

      class Order {
        @OneToMany(() => Item, {
          mappedBy: "orderId",
          cascade: ["delete"],
        })
        items!: Item[];
      }

      const metadata: OneToManyMetadata<Item>[] = Reflect.getMetadata(
        ONE_TO_MANY_TOKEN,
        Order,
      );

      expect(metadata[0].cascade).toEqual(["delete"]);
    });

    it("하위 호환: cascade: ['remove'] 도 허용해야 한다", () => {
      class Item {
        orderId!: number;
      }

      class Order {
        @OneToMany(() => Item, {
          mappedBy: "orderId",
          cascade: ["remove"],
        })
        items!: Item[];
      }

      const metadata: OneToManyMetadata<Item>[] = Reflect.getMetadata(
        ONE_TO_MANY_TOKEN,
        Order,
      );

      expect(metadata[0].cascade).toEqual(["remove"]);
      // hasCascade should treat "remove" same as "delete"
      expect(hasCascade(metadata[0].cascade, "delete")).toBe(true);
    });

    it("여러 @OneToMany 관계에 각각 다른 cascade를 설정할 수 있어야 한다", () => {
      class Post {
        authorId!: number;
      }
      class Comment {
        authorId!: number;
      }

      class User {
        @OneToMany(() => Post, {
          mappedBy: "authorId",
          cascade: ["insert", "update"],
        })
        posts!: Post[];

        @OneToMany(() => Comment, {
          mappedBy: "authorId",
          cascade: ["delete"],
        })
        comments!: Comment[];
      }

      const metadata: OneToManyMetadata<unknown>[] = Reflect.getMetadata(
        ONE_TO_MANY_TOKEN,
        User,
      );

      expect(metadata).toHaveLength(2);

      const postsMeta = metadata.find((m) => m.propertyKey === "posts");
      const commentsMeta = metadata.find((m) => m.propertyKey === "comments");

      expect(postsMeta!.cascade).toEqual(["insert", "update"]);
      expect(commentsMeta!.cascade).toEqual(["delete"]);
    });
  });

  describe("@ManyToOne cascade 데코레이터 통합", () => {
    beforeEach(() => {
      MetadataLayerRegistry.reset();
      Container.reset();
    });

    it("cascade 배열이 메타데이터에 저장되어야 한다", () => {
      class User {
        id!: number;
      }

      class Post {
        @ManyToOne(
          () => User,
          (entity: any) => entity.user,
          { joinColumn: "user_id", cascade: ["insert", "update"] },
        )
        user!: User;
      }

      const metadata: ManyToOneMetadata<any>[] = Reflect.getMetadata(
        MANY_TO_ONE_TOKEN,
        Post,
      );

      expect(metadata).toBeDefined();
      expect(metadata).toHaveLength(1);
      expect(metadata[0].option?.cascade).toEqual(["insert", "update"]);
    });

    it("cascade: true가 메타데이터에 저장되어야 한다", () => {
      class User {
        id!: number;
      }

      class Post {
        @ManyToOne(
          () => User,
          (entity: any) => entity.user,
          { joinColumn: "user_id", cascade: true },
        )
        user!: User;
      }

      const metadata: ManyToOneMetadata<any>[] = Reflect.getMetadata(
        MANY_TO_ONE_TOKEN,
        Post,
      );

      expect(metadata[0].option?.cascade).toBe(true);
    });

    it("cascade 옵션 없이 사용할 수 있어야 한다", () => {
      class User {
        id!: number;
      }

      class Post {
        @ManyToOne(
          () => User,
          (entity: any) => entity.user,
          { joinColumn: "user_id" },
        )
        user!: User;
      }

      const metadata: ManyToOneMetadata<any>[] = Reflect.getMetadata(
        MANY_TO_ONE_TOKEN,
        Post,
      );

      expect(metadata[0].option?.cascade).toBeUndefined();
    });

    it("cascade metadata가 ManyToOneScanner에 등록되어야 한다", () => {
      class User {
        id!: number;
      }

      class Post {
        @ManyToOne(
          () => User,
          (entity: any) => entity.user,
          { joinColumn: "user_id", cascade: ["insert"] },
        )
        user!: User;
      }

      const scanner = Container.get(ManyToOneScanner);
      const allMeta = [...scanner.makeManyToOnes()];

      const postMeta = allMeta.find((m) => m.columnName === "user");
      expect(postMeta).toBeDefined();
      expect(postMeta!.option?.cascade).toEqual(["insert"]);
    });
  });

  describe("Cascade metadata via layer system", () => {
    beforeEach(() => {
      MetadataLayerRegistry.reset();
      Container.reset();
    });

    it("cascade metadata가 OneToManyScanner에 등록되어야 한다", () => {
      class Post {
        userId!: number;
      }

      class User {
        @OneToMany(() => Post, {
          mappedBy: "userId",
          cascade: ["insert", "delete"],
        })
        posts!: Post[];
      }

      const scanner = Container.get(OneToManyScanner);
      const results = scanner.scan(User);

      expect(results).toHaveLength(1);
      expect(results[0].cascade).toEqual(["insert", "delete"]);
    });

    it("cascade metadata가 allMetadata로 조회 가능해야 한다", () => {
      class Post {
        userId!: number;
      }

      class User {
        @OneToMany(() => Post, {
          mappedBy: "userId",
          cascade: true,
        })
        posts!: Post[];
      }

      const scanner = Container.get(OneToManyScanner);
      const allMeta = scanner.allMetadata<OneToManyMetadata<any>>();

      const userPosts = allMeta.find(
        (m) => m.target === User && m.propertyKey === "posts",
      );

      expect(userPosts).toBeDefined();
      expect(userPosts!.cascade).toBe(true);
      expect(hasCascade(userPosts!.cascade, "insert")).toBe(true);
      expect(hasCascade(userPosts!.cascade, "update")).toBe(true);
      expect(hasCascade(userPosts!.cascade, "delete")).toBe(true);
    });

    it("tenant 컨텍스트에서 cascade metadata를 격리해야 한다", () => {
      const scanner = Container.get(OneToManyScanner);

      // Register in public context
      scanner.switchContext("public");

      class PublicChild {}
      class PublicParent {}

      scanner.set("publicCascade", {
        target: PublicParent,
        propertyKey: "children",
        getRelatedEntity: () => PublicChild,
        mappedBy: "parentId",
        cascade: ["insert"],
      });

      // Register in tenant context
      scanner.switchContext("tenant_1");

      class TenantChild {}
      class TenantParent {}

      scanner.set("tenantCascade", {
        target: TenantParent,
        propertyKey: "items",
        getRelatedEntity: () => TenantChild,
        mappedBy: "ownerId",
        cascade: ["insert", "delete"],
      });

      // tenant_1 should see its own cascade metadata
      const tenantMeta = scanner.allMetadata<OneToManyMetadata<any>>();
      const tenantEntry = tenantMeta.find(
        (m: any) => m.propertyKey === "items",
      );
      expect(tenantEntry).toBeDefined();
      expect(tenantEntry!.cascade).toEqual(["insert", "delete"]);

      // Switch to public context
      scanner.switchContext("public");
      const publicMeta = scanner.allMetadata<OneToManyMetadata<any>>();
      const publicEntry = publicMeta.find(
        (m: any) => m.propertyKey === "children",
      );
      expect(publicEntry).toBeDefined();
      expect(publicEntry!.cascade).toEqual(["insert"]);

      // Tenant-only entry should not appear in public context
      const tenantInPublic = publicMeta.find(
        (m: any) => m.propertyKey === "items",
      );
      expect(tenantInPublic).toBeUndefined();
    });
  });
});
