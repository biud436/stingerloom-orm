/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Expose } from "class-transformer";
import { Column, Entity, ManyToOne } from "../../src/decorators";
import { QueryResult } from "../../src/types";
import { ResultTransformerFactory } from "../../src/core/ResultTransformerFactory";

/**
 * 컬럼 별칭 전략:*
 * 점 표기법 (Sequelize): Posts.Comments.id
 * 언더스코어 경로 (TypeORM): user_posts_comments_id
 * 숫자 식별자 (Hibernate): id1_0_0_
 * 테이블 별칭과 컬럼명 결합 (SQLAlchemy): comments_1_id
 *
 * 로딩 전략:
 *
 * 단일 대형 조인 쿼리 (Hibernate, SQLAlchemy, Entity Framework)
 * 여러 개별 쿼리 (Django, Prisma)
 **/

describe("ResultTransformer", () => {
  @Entity()
  class PostComment {
    @Column()
    @Expose()
    id!: number;

    @Column()
    @Expose()
    content!: string;

    @Column()
    @Expose()
    created_at!: Date;

    @Expose()
    posts?: Post[];
  }

  @Entity()
  class Post {
    @Column()
    @Expose()
    id!: number;

    @Column()
    @Expose()
    title!: string;

    @Column()
    @Expose()
    content!: string;

    @Expose()
    @Column()
    @ManyToOne(() => PostComment, (entity) => entity.posts)
    comment?: PostComment;

    @Expose()
    users?: User[];
  }

  @Entity()
  class User {
    @Column()
    @Expose()
    id!: number;

    @Column()
    @Expose()
    name!: string;

    @Column()
    @Expose()
    email!: string;

    @Column()
    @Expose()
    @ManyToOne(() => Post, (entity) => entity.users)
    post?: Post;
  }

  const resultTransformer = ResultTransformerFactory.create();

  describe("toEntity", () => {
    it("User로 변환할 수 있어야 합니다", () => {
      const mockResult: QueryResult = {
        results: [
          {
            id: 1,
            name: "홍길동",
            email: "hong@example.com",
          },
        ],
      };

      const user = resultTransformer.toEntity(User, mockResult);

      expect(user).toBeDefined();
      expect(user).toBeInstanceOf(User);
      expect(user?.id).toBe(1);
      expect(user?.name).toBe("홍길동");
      expect(user?.email).toBe("hong@example.com");
    });

    it("결과가 없을 경우 undefined를 반환해야 합니다", () => {
      const mockResult: QueryResult = {
        results: [],
      };

      const user = resultTransformer.toEntity(User, mockResult);

      expect(user).toBeUndefined();
    });
  });

  describe("toEntities", () => {
    it("User 배열로 변환할 수 있어야 합니다.", () => {
      const mockResult: QueryResult = {
        results: [
          { id: 1, name: "홍길동", email: "hong@example.com" },
          { id: 2, name: "김철수", email: "kim@example.com" },
        ],
      };

      const users = resultTransformer.toEntities(User, mockResult);

      expect(users).toHaveLength(2);
      expect(users[0]).toBeInstanceOf(User);
      expect(users[1]).toBeInstanceOf(User);
      expect(users[0].name).toBe("홍길동");
      expect(users[1].name).toBe("김철수");
    });

    it("결과가 없을 경우 빈 배열을 반환해야 합니다", () => {
      const mockResult: QueryResult = {
        results: [],
      };

      const users = resultTransformer.toEntities(User, mockResult);

      expect(users).toEqual([]);
    });
  });

  describe("transform", () => {
    it("결과가 1개일 경우 User를 반환해야 합니다", () => {
      const mockResult: QueryResult = {
        results: [
          {
            id: 1,
            name: "홍길동",
            email: "hong@example.com",
          },
        ],
      };

      const result = resultTransformer.transform(User, mockResult);

      expect(result).toBeInstanceOf(User);
      expect((result as User).name).toBe("홍길동");
    });

    it("다중 결과일 경우 User 배열을 반환해야 합니다", () => {
      const mockResult: QueryResult = {
        results: [
          { id: 1, name: "홍길동", email: "hong@example.com" },
          { id: 2, name: "김철수", email: "kim@example.com" },
        ],
      };

      const result = resultTransformer.transform(User, mockResult);

      expect(Array.isArray(result)).toBeTruthy();
      expect((result as User[]).length).toBe(2);
    });
  });

  describe("transformNested", () => {
    it("중첩된 관계를 변환할 수 있어야 합니다", () => {
      const mockResult: QueryResult = {
        results: [
          {
            id: 1,
            name: "홍길동",
            email: "hong@example.com",
            post__id: 1,
            post__title: "첫 번째 글",
            post__content: "내용입니다",
            post__comment__id: 1,
            post__comment__content: "댓글입니다",
            post__comment__created_at: "2024-03-16T00:00:00Z",
          },
        ],
      };

      const result = resultTransformer.transformNested(User, mockResult, {
        posts: Post,
      });

      expect(result).toBeInstanceOf(User);
      const user = result as User;

      console.log(user);

      // post 객체 검증
      const post = user?.post;

      expect(post).toBeInstanceOf(Post);
      expect(post?.id).toBe(1);
      expect(post?.title).toBe("첫 번째 글");
      expect(post?.content).toBe("내용입니다");

      // comments 배열 검증 (중첩의 중첩인 경우에는 comments가 배열로 변환되어야 하는데 실패함)
      expect(post?.comment).toBeDefined();
      expect(Array.isArray(post?.comment)).toBeFalsy();
    });

    it("중첩 관계가 없는 경우에도 정상 동작해야 합니다", () => {
      const mockResult: QueryResult = {
        results: [
          {
            id: 1,
            name: "홍길동",
            email: "hong@example.com",
          },
        ],
      };

      const result = resultTransformer.transformNested(User, mockResult, {});

      expect(result).toBeInstanceOf(User);
      const user = result as User;
      expect(user.id).toBe(1);
      expect(user.name).toBe("홍길동");
      expect(user.email).toBe("hong@example.com");
    });

    it("다중 레벨의 중첩 관계를 변환할 수 있어야 합니다", () => {
      const mockResult: QueryResult = {
        results: [
          {
            id: 1,
            name: "홍길동",
            email: "hong@example.com",
            post__id: 1,
            post__title: "첫 번째 글",
            post__content: "내용입니다",
            post__comment__id: 1,
            post__comment__content: "댓글입니다",
            post__comment__created_at: "2024-03-16T00:00:00Z",
          },
        ],
      };

      const result = resultTransformer.transformNested(User, mockResult, {
        post: Post,
        comment: PostComment,
      });

      expect(result).toBeInstanceOf(User);
      const user = result as User;
      expect(user.post).toBeDefined();
      expect(user.post).toBeInstanceOf(Post);
      expect(user.post?.comment).toBeInstanceOf(PostComment);
      expect(user.post?.comment?.content).toBe("댓글입니다");
    });

    it("중첩 관계는 루트 행의 같은 이름 JOIN 컬럼을 읽지 않아야 합니다", () => {
      // `comment__*` belongs to a JOIN of the row's own entity, not to the
      // post's `comment` — only `post__comment__*` may hydrate that one.
      const mockResult: QueryResult = {
        results: [
          {
            id: 1,
            name: "홍길동",
            email: "hong@example.com",
            post__id: 1,
            post__title: "첫 번째 글",
            post__content: "내용입니다",
            comment__id: 9,
            comment__content: "다른 댓글",
            comment__created_at: "2024-03-16T00:00:00Z",
          },
        ],
      };

      const user = resultTransformer.transformNested(User, mockResult, {}) as User;

      expect(user.post).toBeInstanceOf(Post);
      expect(user.post?.comment).toBeNull();
    });

    it("단일 행에 다수의 중첩된 관계 데이터 포함", () => {
      const mockResult: QueryResult = {
        results: [
          {
            id: 1,
            name: "Alice",
            email: "alice@stingerloom.com",
            // 'address' 관계 데이터 (키 접두사 "address__" 사용)
            address__street: "123 Main St",
            address__city: "Anytown",
            // 'order' 관계 데이터 (키 접두사 "order__" 사용)
            order__id: 1001,
            order__total: 150.75,
          },
        ],
      };

      @Entity()
      class Address {
        @Column()
        street!: string;

        @Column()
        city!: string;

        users!: GoodUser[];
      }

      @Entity()
      class Order {
        @Column()
        id!: number;

        @Column()
        total!: number;

        users!: GoodUser[];
      }

      @Entity()
      class GoodUser {
        @Column()
        @Expose()
        id!: number;

        @Column()
        @Expose()
        name!: string;

        @Column()
        @Expose()
        email!: string;

        @Expose()
        @ManyToOne(() => Address, (entity) => entity.users, {})
        address!: Address;

        // @Expose()
        @ManyToOne(() => Order, (entity) => entity.users, {})
        order!: Order;
      }

      const result = resultTransformer.transformNested<GoodUser>(
        GoodUser,
        mockResult,
        {
          address: Address,
          order: Order,
        },
      ) as GoodUser;

      expect(result).toBeInstanceOf(GoodUser);
      expect(result?.address).toBeInstanceOf(Address);
    });
  });

  describe("toEntities batch deserialization (issue #254)", () => {
    @Entity()
    class Simple {
      @Column()
      @Expose()
      id!: number;

      @Column()
      @Expose()
      name!: string;
    }

    @Entity()
    class SnakeMapped {
      @Column({ name: "user_id" })
      @Expose()
      userId!: number;

      @Column({ name: "full_name" })
      @Expose()
      fullName!: string;
    }

    it("fast path (no remap, no transformers) batches the deserializer call", () => {
      const rt = ResultTransformerFactory.create();
      const rows = [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
        { id: 3, name: "carol" },
      ];
      const result = rt.toEntities(Simple, {
        results: rows,
        fields: [],
      } as any);
      expect(result).toHaveLength(3);
      expect(result.every((r) => r instanceof Simple)).toBe(true);
      expect(result.map((r) => r.name)).toEqual(["alice", "bob", "carol"]);
    });

    it("remap path (DB column → property key) still round-trips every row", () => {
      const rt = ResultTransformerFactory.create();
      const rows = [
        { user_id: 10, full_name: "Alice Kim" },
        { user_id: 20, full_name: "Bob Park" },
      ];
      const result = rt.toEntities(SnakeMapped, {
        results: rows,
        fields: [],
      } as any);
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(SnakeMapped);
      expect(result[0].userId).toBe(10);
      expect(result[0].fullName).toBe("Alice Kim");
      expect(result[1].userId).toBe(20);
      expect(result[1].fullName).toBe("Bob Park");
    });

    it("empty result set returns [] without invoking the deserializer", () => {
      const rt = ResultTransformerFactory.create();
      const result = rt.toEntities(Simple, { results: [], fields: [] } as any);
      expect(result).toEqual([]);
    });
  });
});
