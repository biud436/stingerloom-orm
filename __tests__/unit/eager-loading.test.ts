import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import {
  ManyToOne,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
  ManyToOneOption,
} from "../../src/decorators/ManyToOne";
import { OneToMany, ONE_TO_MANY_TOKEN } from "../../src/decorators/OneToMany";
import { ManyToOneScanner } from "../../src/scanner/ManyToOneScanner";
import { OneToManyScanner } from "../../src/scanner/OneToManyScanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe("@ManyToOne eager option", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should store eager: true in ManyToOne metadata option", () => {
    class User {}

    class Post {
      @ManyToOne(
        () => User,
        (entity: any) => entity.user,
        { joinColumn: "user_id", eager: true },
      )
      user!: User;
    }

    const metadata: ManyToOneMetadata<User>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Post,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].option?.eager).toBe(true);
    expect(metadata[0].option?.joinColumn).toBe("user_id");
    expect(metadata[0].columnName).toBe("user");
  });

  it("should default eager to undefined when not specified", () => {
    class Category {}

    class Product {
      @ManyToOne(
        () => Category,
        (entity: any) => entity.category,
        { joinColumn: "category_id" },
      )
      category!: Category;
    }

    const metadata: ManyToOneMetadata<Category>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Product,
    );

    expect(metadata).toBeDefined();
    expect(metadata[0].option?.eager).toBeUndefined();
  });

  it("should store eager: false explicitly", () => {
    class Department {}

    class Employee {
      @ManyToOne(
        () => Department,
        (entity: any) => entity.department,
        { joinColumn: "dept_id", eager: false },
      )
      department!: Department;
    }

    const metadata: ManyToOneMetadata<Department>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Employee,
    );

    expect(metadata[0].option?.eager).toBe(false);
  });

  it("should register eager metadata in ManyToOneScanner", () => {
    class Author {}

    class Book {
      @ManyToOne(
        () => Author,
        (entity: any) => entity.author,
        { joinColumn: "author_id", eager: true },
      )
      author!: Author;
    }

    const scanner = getScannerInstance(ManyToOneScanner);
    const allRelations = [...scanner.makeManyToOnes()];
    const bookRelation = allRelations.find((r) => r.target === Book);

    expect(bookRelation).toBeDefined();
    expect(bookRelation!.option?.eager).toBe(true);
    expect(bookRelation!.joinColumn).toBe("author_id");
  });

  it("should support multiple ManyToOne with mixed eager settings", () => {
    class Author {}
    class Category {}

    class Article {
      @ManyToOne(
        () => Author,
        (entity: any) => entity.author,
        { joinColumn: "author_id", eager: true },
      )
      author!: Author;

      @ManyToOne(
        () => Category,
        (entity: any) => entity.category,
        { joinColumn: "category_id", eager: false },
      )
      category!: Category;
    }

    const metadata: ManyToOneMetadata<unknown>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Article,
    );

    expect(metadata).toHaveLength(2);

    const authorMeta = metadata.find((m) => m.columnName === "author");
    const categoryMeta = metadata.find((m) => m.columnName === "category");

    expect(authorMeta!.option?.eager).toBe(true);
    expect(categoryMeta!.option?.eager).toBe(false);
  });
});

describe("Eager loading with bidirectional relationships", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should support eager @ManyToOne with @OneToMany inverse", () => {
    class Comment {
      @ManyToOne(
        () => Post,
        (entity: any) => entity.post,
        { joinColumn: "post_id", eager: true },
      )
      post!: any;
    }

    class Post {
      @OneToMany(() => Comment, { mappedBy: "post" })
      comments!: Comment[];
    }

    // Verify ManyToOne eager metadata
    const manyToOneMeta: ManyToOneMetadata<unknown>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Comment,
    );
    expect(manyToOneMeta).toHaveLength(1);
    expect(manyToOneMeta[0].option?.eager).toBe(true);
    expect(manyToOneMeta[0].joinColumn).toBe("post_id");

    // Verify OneToMany inverse metadata
    const oneToManyMeta = Reflect.getMetadata(ONE_TO_MANY_TOKEN, Post);
    expect(oneToManyMeta).toHaveLength(1);
    expect(oneToManyMeta[0].mappedBy).toBe("post");
  });
});

describe("ManyToOneOption type", () => {
  it("should accept eager as an optional boolean property", () => {
    const optionWithEager: ManyToOneOption = {
      joinColumn: "fk_id",
      eager: true,
    };
    expect(optionWithEager.eager).toBe(true);

    const optionWithoutEager: ManyToOneOption = {
      joinColumn: "fk_id",
    };
    expect(optionWithoutEager.eager).toBeUndefined();

    const optionWithTransform: ManyToOneOption = {
      joinColumn: "fk_id",
      eager: true,
      transform: <T>(val: unknown) => Number(val) as T,
    };
    expect(optionWithTransform.eager).toBe(true);
    expect(optionWithTransform.transform).toBeDefined();
  });
});
