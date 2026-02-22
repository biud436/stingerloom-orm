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
import { CascadeType } from "../../src/types/CascadeType";

describe("Cascade 옵션", () => {
  describe("CascadeType 타입 정의", () => {
    it("insert, update, remove 타입을 허용해야 한다", () => {
      const types: CascadeType[] = ["insert", "update", "remove"];
      expect(types).toHaveLength(3);
    });

    it("cascade 배열은 부분 집합도 허용해야 한다", () => {
      const insertOnly: CascadeType[] = ["insert"];
      const removeOnly: CascadeType[] = ["remove"];
      expect(insertOnly).toEqual(["insert"]);
      expect(removeOnly).toEqual(["remove"]);
    });
  });

  describe("@OneToMany cascade 데코레이터 통합", () => {
    beforeEach(() => {
      MetadataLayerRegistry.reset();
      Container.reset();
    });

    it("cascade 옵션이 @OneToMany 데코레이터를 통해 메타데이터에 저장되어야 한다", () => {
      class Post {
        userId!: number;
      }

      class User {
        @OneToMany(() => Post, {
          mappedBy: "userId",
          cascade: ["insert", "update", "remove"],
        })
        posts!: Post[];
      }

      const metadata: OneToManyMetadata<Post>[] = Reflect.getMetadata(
        ONE_TO_MANY_TOKEN,
        User,
      );

      expect(metadata).toBeDefined();
      expect(metadata).toHaveLength(1);
      expect(metadata[0].cascade).toEqual(["insert", "update", "remove"]);
    });

    it("cascade 옵션 없이 @OneToMany를 사용할 수 있어야 한다", () => {
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

    it("cascade: ['remove'] 만 설정할 수 있어야 한다", () => {
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
          cascade: ["remove"],
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
      expect(commentsMeta!.cascade).toEqual(["remove"]);
    });
  });

  describe("@ManyToOne cascade 데코레이터 통합", () => {
    beforeEach(() => {
      MetadataLayerRegistry.reset();
      Container.reset();
    });

    it("cascade 옵션이 @ManyToOne 데코레이터를 통해 메타데이터에 저장되어야 한다", () => {
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

    it("cascade 옵션 없이 @ManyToOne을 사용할 수 있어야 한다", () => {
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

  describe("Cascade 판별 로직", () => {
    it("cascade insert/update 포함 여부를 배열로 확인할 수 있어야 한다", () => {
      const hasSaveCascade = (cascade: CascadeType[] | undefined) => {
        return cascade?.includes("insert") || cascade?.includes("update");
      };

      expect(hasSaveCascade(["insert"])).toBe(true);
      expect(hasSaveCascade(["update"])).toBe(true);
      expect(hasSaveCascade(["insert", "remove"])).toBe(true);
      expect(hasSaveCascade(["remove"])).toBeFalsy();
      expect(hasSaveCascade(undefined)).toBeFalsy();
      expect(hasSaveCascade([])).toBeFalsy();
    });

    it("cascade remove 포함 여부를 배열로 확인할 수 있어야 한다", () => {
      const hasRemoveCascade = (cascade: CascadeType[] | undefined) => {
        return cascade?.includes("remove");
      };

      expect(hasRemoveCascade(["remove"])).toBe(true);
      expect(hasRemoveCascade(["insert", "remove"])).toBe(true);
      expect(hasRemoveCascade(["insert"])).toBeFalsy();
      expect(hasRemoveCascade(undefined)).toBeFalsy();
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
          cascade: ["insert", "remove"],
        })
        posts!: Post[];
      }

      const scanner = Container.get(OneToManyScanner);
      const results = scanner.scan(User);

      expect(results).toHaveLength(1);
      expect(results[0].cascade).toEqual(["insert", "remove"]);
    });

    it("cascade metadata가 allMetadata로 조회 가능해야 한다", () => {
      class Post {
        userId!: number;
      }

      class User {
        @OneToMany(() => Post, {
          mappedBy: "userId",
          cascade: ["insert", "update", "remove"],
        })
        posts!: Post[];
      }

      const scanner = Container.get(OneToManyScanner);
      const allMeta = scanner.allMetadata<OneToManyMetadata<any>>();

      const userPosts = allMeta.find(
        (m) => m.target === User && m.propertyKey === "posts",
      );

      expect(userPosts).toBeDefined();
      expect(userPosts!.cascade).toEqual(["insert", "update", "remove"]);
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
        cascade: ["insert", "remove"],
      });

      // tenant_1 should see its own cascade metadata
      const tenantMeta = scanner.allMetadata<OneToManyMetadata<any>>();
      const tenantEntry = tenantMeta.find(
        (m: any) => m.propertyKey === "items",
      );
      expect(tenantEntry).toBeDefined();
      expect(tenantEntry!.cascade).toEqual(["insert", "remove"]);

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
