import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import {
  ManyToOne,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
  ManyToOneOption,
} from "../../src/decorators/ManyToOne";
import { ManyToOneScanner } from "../../src/scanner/ManyToOneScanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import {
  createLazyProxy,
  injectLazyProxy,
  isLazyProxy,
  loadLazy,
} from "../../src/core/LazyLoader";

describe("@ManyToOne lazy option - metadata", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should store lazy: true in ManyToOne metadata option", () => {
    class User {}

    class Post {
      @ManyToOne(
        () => User,
        (entity: any) => entity.user,
        { joinColumn: "user_id", lazy: true },
      )
      user!: User;
    }

    const metadata: ManyToOneMetadata<User>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Post,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].option?.lazy).toBe(true);
    expect(metadata[0].option?.joinColumn).toBe("user_id");
    expect(metadata[0].columnName).toBe("user");
  });

  it("should default lazy to undefined when not specified", () => {
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
    expect(metadata[0].option?.lazy).toBeUndefined();
  });

  it("should store lazy: false explicitly", () => {
    class Department {}

    class Employee {
      @ManyToOne(
        () => Department,
        (entity: any) => entity.department,
        { joinColumn: "dept_id", lazy: false },
      )
      department!: Department;
    }

    const metadata: ManyToOneMetadata<Department>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Employee,
    );

    expect(metadata[0].option?.lazy).toBe(false);
  });

  it("should register lazy metadata in ManyToOneScanner", () => {
    class Author {}

    class Book {
      @ManyToOne(
        () => Author,
        (entity: any) => entity.author,
        { joinColumn: "author_id", lazy: true },
      )
      author!: Author;
    }

    const scanner = getScannerInstance(ManyToOneScanner);
    const allRelations = [...scanner.makeManyToOnes()];
    const bookRelation = allRelations.find((r) => r.target === Book);

    expect(bookRelation).toBeDefined();
    expect(bookRelation!.option?.lazy).toBe(true);
    expect(bookRelation!.joinColumn).toBe("author_id");
  });

  it("should support mixed eager and lazy settings on different relations", () => {
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
        { joinColumn: "category_id", lazy: true },
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
    expect(authorMeta!.option?.lazy).toBeUndefined();
    expect(categoryMeta!.option?.lazy).toBe(true);
    expect(categoryMeta!.option?.eager).toBeUndefined();
  });
});

describe("ManyToOneOption type - lazy", () => {
  it("should accept lazy as an optional boolean property", () => {
    const optionWithLazy: ManyToOneOption = {
      joinColumn: "fk_id",
      lazy: true,
    };
    expect(optionWithLazy.lazy).toBe(true);

    const optionWithoutLazy: ManyToOneOption = {
      joinColumn: "fk_id",
    };
    expect(optionWithoutLazy.lazy).toBeUndefined();

    const optionWithBoth: ManyToOneOption = {
      joinColumn: "fk_id",
      eager: true,
      lazy: true,
    };
    expect(optionWithBoth.eager).toBe(true);
    expect(optionWithBoth.lazy).toBe(true);
  });
});

describe("createLazyProxy", () => {
  it("should not call loadFn until property is accessed", () => {
    const loadFn = jest.fn().mockResolvedValue({ id: 1, name: "Alice" });
    const proxy = createLazyProxy(loadFn);

    // loadFn should not be called just from creating the proxy
    expect(loadFn).not.toHaveBeenCalled();
    expect(proxy).toBeDefined();
  });

  it("should call loadFn when a property is accessed", () => {
    const loadFn = jest.fn().mockResolvedValue({ id: 1, name: "Alice" });
    const proxy = createLazyProxy(loadFn);

    // Accessing a property triggers the load
    const _name = (proxy as any).name;
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("should not trigger loadFn for 'then', 'catch', 'finally' access", () => {
    const loadFn = jest.fn().mockResolvedValue({ id: 1, name: "Alice" });
    const proxy = createLazyProxy(loadFn);

    // 'then' access should not trigger loadFn (prevents thenable detection)
    const then = (proxy as any).then;
    expect(then).toBeUndefined();
    expect(loadFn).not.toHaveBeenCalled();
  });

  it("should return cached value after loadFn resolves", async () => {
    const user = { id: 1, name: "Bob" };
    const loadFn = jest.fn().mockResolvedValue(user);
    const proxy = createLazyProxy(loadFn);

    // First access triggers load
    const _val = (proxy as any).name;
    expect(loadFn).toHaveBeenCalledTimes(1);

    // Wait for the load to complete
    await new Promise((r) => setTimeout(r, 10));

    // Second access should use cache and not call loadFn again
    const name = (proxy as any).name;
    expect(name).toBe("Bob");
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("should not call loadFn multiple times for concurrent access before resolve", () => {
    const loadFn = jest.fn().mockResolvedValue({ id: 1 });
    const proxy = createLazyProxy(loadFn);

    // Multiple accesses before resolve should share the same promise
    (proxy as any).id;
    (proxy as any).id;
    (proxy as any).id;

    expect(loadFn).toHaveBeenCalledTimes(1);
  });
});

describe("isLazyProxy", () => {
  it("should return true for a lazy proxy", () => {
    const proxy = createLazyProxy(async () => ({ id: 1 }));
    expect(isLazyProxy(proxy)).toBe(true);
  });

  it("should return false for a plain object", () => {
    expect(isLazyProxy({ id: 1 })).toBe(false);
  });

  it("should return false for null and undefined", () => {
    expect(isLazyProxy(null)).toBe(false);
    expect(isLazyProxy(undefined)).toBe(false);
  });

  it("should return false for primitive types", () => {
    expect(isLazyProxy(42)).toBe(false);
    expect(isLazyProxy("string")).toBe(false);
    expect(isLazyProxy(true)).toBe(false);
  });
});

describe("loadLazy", () => {
  it("should call the load function and return the result", async () => {
    const user = { id: 1, name: "Charlie" };
    const loadFn = jest.fn().mockResolvedValue(user);

    const result = await loadLazy(loadFn);

    expect(loadFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual(user);
  });

  it("should return undefined when loadFn returns undefined", async () => {
    const loadFn = jest.fn().mockResolvedValue(undefined);

    const result = await loadLazy(loadFn);

    expect(result).toBeUndefined();
  });
});

describe("injectLazyProxy", () => {
  it("should inject a getter on the target entity", () => {
    const entity: any = { id: 1, user_id: 10 };
    const user = { id: 10, name: "David" };

    injectLazyProxy(entity, "user", async () => user);

    // The property should be defined
    const descriptor = Object.getOwnPropertyDescriptor(entity, "user");
    expect(descriptor).toBeDefined();
    expect(descriptor!.get).toBeDefined();
  });

  it("should return a promise on first access", () => {
    const entity: any = { id: 1, user_id: 10 };
    const user = { id: 10, name: "Eve" };

    injectLazyProxy(entity, "user", async () => user);

    const result = entity.user;
    // First access returns a Promise
    expect(result).toBeInstanceOf(Promise);
  });

  it("should resolve to the loaded entity", async () => {
    const entity: any = { id: 1, user_id: 10 };
    const user = { id: 10, name: "Frank" };

    injectLazyProxy(entity, "user", async () => user);

    const result = await entity.user;
    expect(result).toEqual(user);
  });

  it("should replace getter with value after loading", async () => {
    const entity: any = { id: 1, user_id: 10 };
    const user = { id: 10, name: "Grace" };
    const loadFn = jest.fn().mockResolvedValue(user);

    injectLazyProxy(entity, "user", loadFn);

    // First access: triggers load
    await entity.user;

    // After loading, the property should be a regular value
    const descriptor = Object.getOwnPropertyDescriptor(entity, "user");
    expect(descriptor!.value).toEqual(user);
    expect(descriptor!.get).toBeUndefined();

    // Subsequent access should not call loadFn again
    const result = entity.user;
    expect(result).toEqual(user);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("should allow setting a value directly (bypasses lazy loading)", () => {
    const entity: any = { id: 1, user_id: 10 };
    const directUser = { id: 10, name: "Heidi" };

    injectLazyProxy(entity, "user", async () => ({ id: 99, name: "Nobody" }));

    // Setting the property directly should bypass lazy loading
    entity.user = directUser;

    expect(entity.user).toEqual(directUser);
  });

  it("should call loadFn only once even with multiple awaits", async () => {
    const entity: any = { id: 1, user_id: 10 };
    const user = { id: 10, name: "Ivan" };
    const loadFn = jest.fn().mockResolvedValue(user);

    injectLazyProxy(entity, "user", loadFn);

    // Multiple awaits
    await entity.user;
    const result = entity.user;

    expect(result).toEqual(user);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("should call loadFn only once for concurrent accesses before resolution", async () => {
    const entity: any = { id: 1, user_id: 10 };
    const user = { id: 10, name: "Ivan" };
    const loadFn = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(user), 10)),
    );

    injectLazyProxy(entity, "user", loadFn as any);

    // Two accesses BEFORE the first load resolves must share one in-flight load
    const p1 = entity.user;
    const p2 = entity.user;
    expect(p1).toBe(p2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(loadFn).toHaveBeenCalledTimes(1);
    expect(entity.user).toEqual(user);
  });

  it("should keep a directly-set value even if it races an in-flight load", async () => {
    const entity: any = { id: 1, user_id: 10 };
    const dbUser = { id: 10, name: "FromDB" };
    const loadFn = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(dbUser), 10)),
    );

    injectLazyProxy(entity, "user", loadFn as any);

    const pending = entity.user; // starts the load
    entity.user = { id: 10, name: "Assigned" }; // setter wins the race

    await pending;
    expect(entity.user).toEqual({ id: 10, name: "Assigned" });
  });

  it("should handle loadFn returning undefined", async () => {
    const entity: any = { id: 1, user_id: 10 };
    const loadFn = jest.fn().mockResolvedValue(undefined);

    injectLazyProxy(entity, "user", loadFn);

    const result = await entity.user;
    expect(result).toBeUndefined();
  });

  it("should not interfere with other properties on the entity", async () => {
    const entity: any = { id: 1, user_id: 10, name: "Post title" };
    const user = { id: 10, name: "Julia" };

    injectLazyProxy(entity, "user", async () => user);

    // Other properties should remain unchanged
    expect(entity.id).toBe(1);
    expect(entity.user_id).toBe(10);
    expect(entity.name).toBe("Post title");
  });

  it("should work with multiple lazy properties on same entity", async () => {
    const entity: any = { id: 1, author_id: 10, category_id: 20 };
    const author = { id: 10, name: "Author" };
    const category = { id: 20, name: "Category" };

    injectLazyProxy(entity, "author", async () => author);
    injectLazyProxy(entity, "category", async () => category);

    const loadedAuthor = await entity.author;
    const loadedCategory = await entity.category;

    expect(loadedAuthor).toEqual(author);
    expect(loadedCategory).toEqual(category);
  });
});

describe("createLazyProxy - race condition fix (undefined/null loadFn result)", () => {
  it("should call loadFn only once when it returns undefined", async () => {
    const loadFn = jest.fn().mockResolvedValue(undefined);
    const proxy = createLazyProxy(loadFn);

    // Trigger first load
    (proxy as any).someProp;
    expect(loadFn).toHaveBeenCalledTimes(1);

    // Wait for resolve
    await new Promise((r) => setTimeout(r, 10));

    // Access again — should NOT call loadFn again
    const val = (proxy as any).someProp;
    expect(val).toBeUndefined();
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("should call loadFn only once when it returns null", async () => {
    const loadFn = jest.fn().mockResolvedValue(null);
    const proxy = createLazyProxy(loadFn);

    // Trigger first load
    (proxy as any).someProp;
    expect(loadFn).toHaveBeenCalledTimes(1);

    // Wait for resolve
    await new Promise((r) => setTimeout(r, 10));

    // Access again — should NOT call loadFn again
    const val = (proxy as any).someProp;
    expect(val).toBeUndefined();
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("should handle 'has' trap correctly when loadFn returns null", async () => {
    const loadFn = jest.fn().mockResolvedValue(null);
    const proxy = createLazyProxy(loadFn);

    // Trigger load
    (proxy as any).id;
    await new Promise((r) => setTimeout(r, 10));

    // 'in' check should return false for null result
    expect("id" in proxy).toBe(false);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("should call loadFn only once with concurrent access (Promise.all)", async () => {
    let resolveLoad!: (v: any) => void;
    const loadFn = jest.fn(
      () => new Promise<{ id: number } | undefined>((resolve) => { resolveLoad = resolve; }),
    );

    const proxy = createLazyProxy(loadFn);

    // 10 concurrent accesses
    const accesses = Array.from({ length: 10 }, () => {
      return new Promise<any>((resolve) => {
        const val = (proxy as any).id;
        resolve(val);
      });
    });

    await Promise.all(accesses);

    // loadFn should only be called once despite 10 concurrent accesses
    expect(loadFn).toHaveBeenCalledTimes(1);

    // Resolve and verify cached access works
    resolveLoad!({ id: 42 });
    await new Promise((r) => setTimeout(r, 10));

    const result = (proxy as any).id;
    expect(result).toBe(42);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });
});

describe("Lazy loading - eager takes precedence", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("should have both eager and lazy flags accessible in metadata", () => {
    class User {}

    class Post {
      @ManyToOne(
        () => User,
        (entity: any) => entity.user,
        { joinColumn: "user_id", eager: true, lazy: true },
      )
      user!: User;
    }

    const metadata: ManyToOneMetadata<User>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Post,
    );

    expect(metadata[0].option?.eager).toBe(true);
    expect(metadata[0].option?.lazy).toBe(true);
    // In EntityManager.find(), eager takes precedence:
    // lazyRelations filter excludes eager === true
  });

  it("should filter lazy relations correctly (lazy: true, eager: not true)", () => {
    class A {}
    class B {}
    class C {}

    class Entity {
      @ManyToOne(() => A, (e: any) => e.a, { joinColumn: "a_id", eager: true })
      a!: A;

      @ManyToOne(() => B, (e: any) => e.b, { joinColumn: "b_id", lazy: true })
      b!: B;

      @ManyToOne(() => C, (e: any) => e.c, { joinColumn: "c_id" })
      c!: C;
    }

    const metadata: ManyToOneMetadata<unknown>[] = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      Entity,
    );

    // Simulate EntityManager's filter logic
    const lazyRelations = metadata.filter((rel) => {
      return rel.option?.lazy === true && rel.option?.eager !== true;
    });

    expect(lazyRelations).toHaveLength(1);
    expect(lazyRelations[0].columnName).toBe("b");
  });
});
