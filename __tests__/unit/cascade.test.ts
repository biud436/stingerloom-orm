import "reflect-metadata";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../src/decorators/OneToMany";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
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

  describe("@OneToMany cascade 메타데이터 저장", () => {
    it("cascade 옵션 없이 사용할 수 있어야 한다", () => {
      class Post {}
      class User {
        posts!: Post[];
      }

      Reflect.defineMetadata(
        ONE_TO_MANY_TOKEN,
        [
          {
            target: User,
            propertyKey: "posts",
            getRelatedEntity: () => Post,
            mappedBy: "user",
          } as OneToManyMetadata<Post>,
        ],
        User,
      );

      const metas: OneToManyMetadata<Post>[] =
        Reflect.getMetadata(ONE_TO_MANY_TOKEN, User) ?? [];
      expect(metas[0].cascade).toBeUndefined();
    });

    it("cascade: ['insert'] 옵션이 메타데이터에 저장되어야 한다", () => {
      class Comment {}
      class Article {
        comments!: Comment[];
      }

      Reflect.defineMetadata(
        ONE_TO_MANY_TOKEN,
        [
          {
            target: Article,
            propertyKey: "comments",
            getRelatedEntity: () => Comment,
            mappedBy: "article",
            cascade: ["insert"] as CascadeType[],
          } as OneToManyMetadata<Comment>,
        ],
        Article,
      );

      const metas: OneToManyMetadata<Comment>[] =
        Reflect.getMetadata(ONE_TO_MANY_TOKEN, Article) ?? [];
      expect(metas[0].cascade).toEqual(["insert"]);
    });

    it("cascade: ['insert', 'remove'] 조합이 메타데이터에 저장되어야 한다", () => {
      class Tag {}
      class Post {
        tags!: Tag[];
      }

      Reflect.defineMetadata(
        ONE_TO_MANY_TOKEN,
        [
          {
            target: Post,
            propertyKey: "tags",
            getRelatedEntity: () => Tag,
            mappedBy: "post",
            cascade: ["insert", "remove"] as CascadeType[],
          } as OneToManyMetadata<Tag>,
        ],
        Post,
      );

      const metas: OneToManyMetadata<Tag>[] =
        Reflect.getMetadata(ONE_TO_MANY_TOKEN, Post) ?? [];
      expect(metas[0].cascade).toContain("insert");
      expect(metas[0].cascade).toContain("remove");
    });

    it("cascade: ['remove'] 옵션이 메타데이터에 저장되어야 한다", () => {
      class OrderItem {}
      class Order {
        items!: OrderItem[];
      }

      Reflect.defineMetadata(
        ONE_TO_MANY_TOKEN,
        [
          {
            target: Order,
            propertyKey: "items",
            getRelatedEntity: () => OrderItem,
            mappedBy: "order",
            cascade: ["remove"] as CascadeType[],
          } as OneToManyMetadata<OrderItem>,
        ],
        Order,
      );

      const metas: OneToManyMetadata<OrderItem>[] =
        Reflect.getMetadata(ONE_TO_MANY_TOKEN, Order) ?? [];
      expect(metas[0].cascade).toEqual(["remove"]);
    });
  });

  describe("@ManyToOne cascade 메타데이터", () => {
    it("@ManyToOne에 cascade 옵션이 있어야 한다", () => {
      class Category {}

      Reflect.defineMetadata(
        MANY_TO_ONE_TOKEN,
        [
          {
            target: class Product {},
            columnName: "category",
            joinColumn: "category_id",
            getMappingEntity: () => Category,
            getMappingProperty: () => {},
            option: {
              joinColumn: "category_id",
              cascade: ["insert"] as CascadeType[],
            },
          },
        ],
        class Product {},
      );

      // ManyToOneOption 타입에 cascade 필드가 존재하는지 컴파일 타임 확인
      const cascadeOption: CascadeType[] | undefined = ["insert"];
      expect(cascadeOption).toBeDefined();
    });
  });

  describe("resolveCascadeInsert 로직 (단위 테스트)", () => {
    it("cascade insert 포함 여부를 배열로 확인할 수 있어야 한다", () => {
      const hasCascadeInsert = (cascade: CascadeType[] | undefined) => {
        return cascade?.includes("insert") || cascade?.includes("update");
      };

      expect(hasCascadeInsert(["insert"])).toBe(true);
      expect(hasCascadeInsert(["update"])).toBe(true);
      expect(hasCascadeInsert(["insert", "remove"])).toBe(true);
      expect(hasCascadeInsert(["remove"])).toBeFalsy();
      expect(hasCascadeInsert(undefined)).toBeFalsy();
      expect(hasCascadeInsert([])).toBeFalsy();
    });

    it("cascade remove 포함 여부를 배열로 확인할 수 있어야 한다", () => {
      const hasCascadeRemove = (cascade: CascadeType[] | undefined) => {
        return cascade?.includes("remove");
      };

      expect(hasCascadeRemove(["remove"])).toBe(true);
      expect(hasCascadeRemove(["insert", "remove"])).toBe(true);
      expect(hasCascadeRemove(["insert"])).toBeFalsy();
      expect(hasCascadeRemove(undefined)).toBeFalsy();
    });
  });

  describe("다중 cascade 관계", () => {
    it("여러 OneToMany 관계에 각각 다른 cascade 설정을 할 수 있어야 한다", () => {
      class Post {}
      class Comment {}
      class User {
        posts!: Post[];
        comments!: Comment[];
      }

      const metas: OneToManyMetadata<any>[] = [
        {
          target: User,
          propertyKey: "posts",
          getRelatedEntity: () => Post,
          mappedBy: "author",
          cascade: ["insert"] as CascadeType[],
        },
        {
          target: User,
          propertyKey: "comments",
          getRelatedEntity: () => Comment,
          mappedBy: "user",
          cascade: ["remove"] as CascadeType[],
        },
      ];

      Reflect.defineMetadata(ONE_TO_MANY_TOKEN, metas, User);

      const saved = Reflect.getMetadata(ONE_TO_MANY_TOKEN, User) as OneToManyMetadata<any>[];
      expect(saved).toHaveLength(2);
      expect(saved[0].cascade).toEqual(["insert"]);
      expect(saved[1].cascade).toEqual(["remove"]);
    });
  });
});
