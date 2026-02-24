import "reflect-metadata";
import {
  getRepositoryToken,
  InjectRepository,
} from "../../src/decorators/InjectRepository";

class Cat {
  id!: number;
  name!: string;
}

class Dog {
  id!: number;
  name!: string;
}

describe("getRepositoryToken()", () => {
  it("should return a symbol for an entity class", () => {
    const token = getRepositoryToken(Cat);
    expect(typeof token).toBe("symbol");
  });

  it("should return the same symbol for the same class on repeated calls", () => {
    const token1 = getRepositoryToken(Cat);
    const token2 = getRepositoryToken(Cat);
    expect(token1).toBe(token2);
  });

  it("should return different symbols for different classes", () => {
    const catToken = getRepositoryToken(Cat);
    const dogToken = getRepositoryToken(Dog);
    expect(catToken).not.toBe(dogToken);
  });

  it("should return different symbols for classes with the same name", () => {
    // Two different classes that happen to have the same name
    const Cat1 = (() => {
      class Cat {
        id!: number;
      }
      return Cat;
    })();
    const Cat2 = (() => {
      class Cat {
        id!: number;
      }
      return Cat;
    })();

    const token1 = getRepositoryToken(Cat1);
    const token2 = getRepositoryToken(Cat2);

    // They are different class references, so tokens must differ
    expect(token1).not.toBe(token2);
  });

  it("should include the class name in the symbol description", () => {
    const token = getRepositoryToken(Cat);
    expect(token.toString()).toContain("Repository_Cat");
  });
});

describe("InjectRepository() decorator", () => {
  it("should return a ParameterDecorator function", () => {
    const decorator = InjectRepository(Cat);
    expect(typeof decorator).toBe("function");
  });

  it("should store injection token metadata on the target constructor", () => {
    class TestService {
      constructor(catRepo: any) {}
    }

    const decorator = InjectRepository(Cat);
    decorator(TestService, undefined, 0);

    const tokens = Reflect.getOwnMetadata("custom:inject_tokens", TestService);
    expect(tokens).toBeDefined();
    expect(tokens[0]).toBe(getRepositoryToken(Cat));
  });

  it("should support multiple injected parameters", () => {
    class TestService {
      constructor(
        catRepo: any,
        dogRepo: any,
      ) {}
    }

    InjectRepository(Cat)(TestService, undefined, 0);
    InjectRepository(Dog)(TestService, undefined, 1);

    const tokens = Reflect.getOwnMetadata("custom:inject_tokens", TestService);
    expect(tokens[0]).toBe(getRepositoryToken(Cat));
    expect(tokens[1]).toBe(getRepositoryToken(Dog));
  });
});
