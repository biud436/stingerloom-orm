import "reflect-metadata";
import {
  NotNull,
  MinLength,
  MaxLength,
  Min,
  Max,
  VALIDATION_TOKEN,
  ValidationMetadata,
} from "../../src/decorators/Validation";
import { EntityValidator } from "../../src/core/EntityValidator";
import { ValidationError } from "../../src/errors/ValidationError";

describe("Validation 데코레이터", () => {
  describe("@NotNull", () => {
    it("메타데이터에 notNull 제약이 저장되어야 한다", () => {
      class User {
        @NotNull()
        name!: string;
      }

      const metas: ValidationMetadata[] =
        Reflect.getMetadata(VALIDATION_TOKEN, User) ?? [];
      expect(metas.some((m) => m.constraint === "notNull" && m.propertyKey === "name")).toBe(true);
    });
  });

  describe("@MinLength", () => {
    it("메타데이터에 minLength 제약과 값이 저장되어야 한다", () => {
      class Post {
        @MinLength(5)
        title!: string;
      }

      const metas: ValidationMetadata[] =
        Reflect.getMetadata(VALIDATION_TOKEN, Post) ?? [];
      const meta = metas.find((m) => m.constraint === "minLength");
      expect(meta).toBeDefined();
      expect(meta!.value).toBe(5);
    });
  });

  describe("@MaxLength", () => {
    it("메타데이터에 maxLength 제약과 값이 저장되어야 한다", () => {
      class Comment {
        @MaxLength(200)
        content!: string;
      }

      const metas: ValidationMetadata[] =
        Reflect.getMetadata(VALIDATION_TOKEN, Comment) ?? [];
      const meta = metas.find((m) => m.constraint === "maxLength");
      expect(meta).toBeDefined();
      expect(meta!.value).toBe(200);
    });
  });

  describe("@Min", () => {
    it("메타데이터에 min 제약과 값이 저장되어야 한다", () => {
      class Product {
        @Min(0)
        price!: number;
      }

      const metas: ValidationMetadata[] =
        Reflect.getMetadata(VALIDATION_TOKEN, Product) ?? [];
      const meta = metas.find((m) => m.constraint === "min");
      expect(meta).toBeDefined();
      expect(meta!.value).toBe(0);
    });
  });

  describe("@Max", () => {
    it("메타데이터에 max 제약과 값이 저장되어야 한다", () => {
      class Score {
        @Max(100)
        value!: number;
      }

      const metas: ValidationMetadata[] =
        Reflect.getMetadata(VALIDATION_TOKEN, Score) ?? [];
      const meta = metas.find((m) => m.constraint === "max");
      expect(meta).toBeDefined();
      expect(meta!.value).toBe(100);
    });
  });

  describe("다중 데코레이터 조합", () => {
    it("여러 제약이 동일 클래스에 등록되어야 한다", () => {
      class Article {
        @NotNull()
        @MinLength(1)
        @MaxLength(100)
        title!: string;

        @NotNull()
        @Min(1)
        @Max(1000)
        views!: number;
      }

      const metas: ValidationMetadata[] =
        Reflect.getMetadata(VALIDATION_TOKEN, Article) ?? [];
      expect(metas.length).toBeGreaterThanOrEqual(5);
    });
  });
});

describe("EntityValidator", () => {
  describe("@NotNull 검증", () => {
    it("null 값이면 ValidationError를 throw해야 한다", () => {
      class User {
        @NotNull()
        name!: string;
      }

      expect(() =>
        EntityValidator.validate(User, { name: null as any }),
      ).toThrow(ValidationError);
    });

    it("undefined 값이면 ValidationError를 throw해야 한다", () => {
      class User {
        @NotNull()
        name!: string;
      }

      expect(() =>
        EntityValidator.validate(User, {}),
      ).toThrow(ValidationError);
    });

    it("값이 있으면 에러 없이 통과해야 한다", () => {
      class User {
        @NotNull()
        name!: string;
      }

      expect(() =>
        EntityValidator.validate(User, { name: "Alice" }),
      ).not.toThrow();
    });
  });

  describe("@MinLength 검증", () => {
    it("최소 길이 미만이면 ValidationError를 throw해야 한다", () => {
      class Post {
        @MinLength(5)
        title!: string;
      }

      expect(() =>
        EntityValidator.validate(Post, { title: "Hi" }),
      ).toThrow(ValidationError);
    });

    it("최소 길이 이상이면 에러 없이 통과해야 한다", () => {
      class Post {
        @MinLength(5)
        title!: string;
      }

      expect(() =>
        EntityValidator.validate(Post, { title: "Hello World" }),
      ).not.toThrow();
    });

    it("정확히 최소 길이와 같으면 통과해야 한다", () => {
      class Post {
        @MinLength(5)
        title!: string;
      }

      expect(() =>
        EntityValidator.validate(Post, { title: "Hello" }),
      ).not.toThrow();
    });
  });

  describe("@MaxLength 검증", () => {
    it("최대 길이 초과이면 ValidationError를 throw해야 한다", () => {
      class Comment {
        @MaxLength(10)
        body!: string;
      }

      expect(() =>
        EntityValidator.validate(Comment, { body: "This is too long string" }),
      ).toThrow(ValidationError);
    });

    it("최대 길이 이하이면 에러 없이 통과해야 한다", () => {
      class Comment {
        @MaxLength(10)
        body!: string;
      }

      expect(() =>
        EntityValidator.validate(Comment, { body: "Short" }),
      ).not.toThrow();
    });
  });

  describe("@Min 검증", () => {
    it("최솟값 미만이면 ValidationError를 throw해야 한다", () => {
      class Product {
        @Min(0)
        price!: number;
      }

      expect(() =>
        EntityValidator.validate(Product, { price: -1 }),
      ).toThrow(ValidationError);
    });

    it("최솟값 이상이면 에러 없이 통과해야 한다", () => {
      class Product {
        @Min(0)
        price!: number;
      }

      expect(() =>
        EntityValidator.validate(Product, { price: 0 }),
      ).not.toThrow();
    });
  });

  describe("@Max 검증", () => {
    it("최댓값 초과이면 ValidationError를 throw해야 한다", () => {
      class Score {
        @Max(100)
        value!: number;
      }

      expect(() =>
        EntityValidator.validate(Score, { value: 101 }),
      ).toThrow(ValidationError);
    });

    it("최댓값 이하이면 에러 없이 통과해야 한다", () => {
      class Score {
        @Max(100)
        value!: number;
      }

      expect(() =>
        EntityValidator.validate(Score, { value: 100 }),
      ).not.toThrow();
    });
  });

  describe("ValidationError 속성", () => {
    it("에러에 field와 constraint 정보가 포함되어야 한다", () => {
      class User {
        @NotNull()
        email!: string;
      }

      try {
        EntityValidator.validate(User, { email: null as any });
        fail("ValidationError가 throw되어야 함");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const err = e as ValidationError;
        expect(err.field).toBe("email");
        expect(err.constraint).toBe("notNull");
        expect(err.message).toContain("email");
      }
    });
  });

  describe("검증 없는 엔티티", () => {
    it("검증 데코레이터가 없는 엔티티는 에러 없이 통과해야 한다", () => {
      class Plain {
        id!: number;
        name!: string;
      }

      expect(() =>
        EntityValidator.validate(Plain, { id: 1, name: "test" }),
      ).not.toThrow();
    });
  });
});
