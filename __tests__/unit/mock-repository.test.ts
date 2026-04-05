import { createMockRepository } from "../../src/testing/createMockRepository";

class User {
  id!: number;
  name!: string;
}

describe("createMockRepository (#231)", () => {
  it("should return mocked find results", async () => {
    const repo = createMockRepository(User, {
      find: async () => [{ id: 1, name: "test" } as User],
    });

    const users = await repo.find();
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("test");
  });

  it("should return mocked findOne results", async () => {
    const repo = createMockRepository(User, {
      findOne: async () => ({ id: 1, name: "alice" } as User),
    });

    const user = await repo.findOne({ where: { id: 1 } as any });
    expect(user!.name).toBe("alice");
  });

  it("should return mocked count", async () => {
    const repo = createMockRepository(User, {
      count: async () => 42,
    });

    const count = await repo.count();
    expect(count).toBe(42);
  });

  it("should throw for unmocked methods", () => {
    const repo = createMockRepository(User, {
      find: async () => [],
    });

    expect(() => repo.findOne({ where: {} as any })).toThrow(
      /method "findOne" was called but not mocked/,
    );
  });

  it("should work with empty overrides", () => {
    const repo = createMockRepository(User);
    expect(repo).toBeDefined();
  });
});
