import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";

/* eslint-disable @typescript-eslint/no-explicit-any */

class User {
  id!: number;
  name!: string;
  email!: string;
}

describe("findAndCount()", () => {
  let em: EntityManager;

  beforeEach(() => {
    em = new EntityManager();
  });

  it("엔티티 배열과 총 개수를 튜플로 반환해야 한다", async () => {
    const users = [
      { id: 1, name: "Alice", email: "alice@test.com" },
      { id: 2, name: "Bob", email: "bob@test.com" },
    ];

    // findAndCount internally uses findInternal + aggregate.
    jest.spyOn(em as any, "findInternal").mockResolvedValue(users as any);
    jest.spyOn((em as any).aggregateHandler, "aggregate").mockResolvedValue(10);
    // Bypass executeInTransaction to run the callback without a session
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const result = await em.findAndCount(User);

    expect(result).toEqual([users, 10]);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toBe(users);
    expect(result[1]).toBe(10);
  });

  it("findInternal()이 단일 객체(정확히 1행 매칭)를 반환해도 배열로 정규화해야 한다", async () => {
    // findInternal returns a single entity (not an array) when exactly one row
    // matches. findAndCount must still hand back a T[] so callers can map/length it.
    const single = { id: 1, name: "OnlyOne", email: "only@test.com" };
    jest.spyOn(em as any, "findInternal").mockResolvedValue(single as any);
    jest.spyOn((em as any).aggregateHandler, "aggregate").mockResolvedValue(1);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const [rows, count] = await em.findAndCount(User);

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([single]);
    expect(rows).toHaveLength(1);
    expect(count).toBe(1);
  });

  it("findInternal()이 null/undefined를 반환하면 빈 배열로 정규화해야 한다", async () => {
    jest.spyOn(em as any, "findInternal").mockResolvedValue(null as any);
    jest.spyOn((em as any).aggregateHandler, "aggregate").mockResolvedValue(0);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const [rows, count] = await em.findAndCount(User);

    expect(rows).toEqual([]);
    expect(count).toBe(0);
  });

  it("where 조건을 findInternal()와 aggregate() 모두에 전달해야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    const aggregateSpy = jest
      .spyOn((em as any).aggregateHandler, "aggregate")
      .mockResolvedValue(0);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const where = { name: "Alice" } as any;
    await em.findAndCount(User, { where });

    expect(findInternalSpy).toHaveBeenCalledWith(User, { where }, {});
    expect(aggregateSpy).toHaveBeenCalledWith(
      User,
      "COUNT",
      "*",
      where,
      {},
      undefined,
      undefined,
      undefined,
    );
  });

  it("take/limit 옵션이 findInternal()에만 영향을 미치고 aggregate()에는 영향을 주지 않아야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([{ id: 1, name: "Alice" }] as any);
    const aggregateSpy = jest
      .spyOn((em as any).aggregateHandler, "aggregate")
      .mockResolvedValue(100);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const findOption = { where: { name: "Alice" } as any, take: 10 };
    const [entities, count] = await em.findAndCount(User, findOption);

    expect(entities).toHaveLength(1);
    expect(count).toBe(100);
    expect(findInternalSpy).toHaveBeenCalledWith(User, findOption, {});
    // Only `where` is passed to aggregate (take/limit are ignored)
    expect(aggregateSpy).toHaveBeenCalledWith(
      User,
      "COUNT",
      "*",
      findOption.where,
      {},
      undefined,
      undefined,
      undefined,
    );
  });

  it("findOption 없이 호출하면 기본값을 사용해야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    const aggregateSpy = jest
      .spyOn((em as any).aggregateHandler, "aggregate")
      .mockResolvedValue(0);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const [entities, count] = await em.findAndCount(User);

    expect(entities).toEqual([]);
    expect(count).toBe(0);
    expect(findInternalSpy).toHaveBeenCalledWith(User, {}, {});
    expect(aggregateSpy).toHaveBeenCalledWith(
      User,
      "COUNT",
      "*",
      undefined,
      {},
      undefined,
      undefined,
      undefined,
    );
  });

  it("findInternal()와 aggregate()를 동일한 세션으로 실행해야 한다", async () => {
    const mockSession = { id: "mock-session" };
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    const aggregateSpy = jest
      .spyOn((em as any).aggregateHandler, "aggregate")
      .mockResolvedValue(0);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn(mockSession),
    );

    await em.findAndCount(User);

    // Both calls must receive the same session
    expect(findInternalSpy).toHaveBeenCalledWith(
      User,
      {},
      mockSession,
    );
    expect(aggregateSpy).toHaveBeenCalledWith(
      User,
      "COUNT",
      "*",
      undefined,
      mockSession,
      undefined,
      undefined,
      undefined,
    );
  });

  it("withDeleted 옵션을 aggregate()에 전달해 [rows, count] 일관성을 유지해야 한다 (#351)", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    const aggregateSpy = jest
      .spyOn((em as any).aggregateHandler, "aggregate")
      .mockResolvedValue(0);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const findOption = { where: { name: "Alice" } as any, withDeleted: true };
    await em.findAndCount(User, findOption);

    // The count half must honor the same withDeleted flag as the rows half,
    // otherwise findAndCount returns an inconsistent [rows, count] tuple.
    expect(findInternalSpy).toHaveBeenCalledWith(User, findOption, {});
    expect(aggregateSpy).toHaveBeenCalledWith(
      User,
      "COUNT",
      "*",
      findOption.where,
      {},
      true,
      undefined,
      undefined,
    );
  });

  it("findInternal() 에러 시 에러를 전파해야 한다", async () => {
    jest
      .spyOn(em as any, "findInternal")
      .mockRejectedValue(new Error("find error"));
    jest.spyOn((em as any).aggregateHandler, "aggregate").mockResolvedValue(0);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    await expect(em.findAndCount(User)).rejects.toThrow("find error");
  });

  it("aggregate() 에러 시 에러를 전파해야 한다", async () => {
    jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    jest
      .spyOn((em as any).aggregateHandler, "aggregate")
      .mockRejectedValue(new Error("count error"));
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    await expect(em.findAndCount(User)).rejects.toThrow("count error");
  });

  it("orderBy, select, relations 등 모든 FindOption을 findInternal()에 전달해야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    jest.spyOn((em as any).aggregateHandler, "aggregate").mockResolvedValue(0);
    jest.spyOn(em as any, "executeReadOnly").mockImplementation(
      async (fn: any) => fn({}),
    );

    const findOption = {
      where: { name: "Alice" } as any,
      orderBy: { id: "DESC" } as any,
      select: { id: true, name: true } as any,
      relations: ["posts" as any],
      take: 5,
    };

    await em.findAndCount(User, findOption);

    expect(findInternalSpy).toHaveBeenCalledWith(User, findOption, {});
  });

  describe("BaseRepository.findAndCount()", () => {
    it("EntityManager.findAndCount()에 위임해야 한다", async () => {
      const users = [{ id: 1, name: "Alice" }];
      const findAndCountSpy = jest
        .spyOn(em, "findAndCount")
        .mockResolvedValue([users as any, 1]);

      const repo = new BaseRepository(User, em);
      const result = await repo.findAndCount({ where: { name: "Alice" } as any });

      expect(result).toEqual([users, 1]);
      expect(findAndCountSpy).toHaveBeenCalledWith(User, {
        where: { name: "Alice" },
      });
    });

    it("옵션 없이 호출할 수 있어야 한다", async () => {
      const findAndCountSpy = jest
        .spyOn(em, "findAndCount")
        .mockResolvedValue([[] as any, 0]);

      const repo = new BaseRepository(User, em);
      const [entities, count] = await repo.findAndCount();

      expect(entities).toEqual([]);
      expect(count).toBe(0);
      expect(findAndCountSpy).toHaveBeenCalledWith(User, undefined);
    });
  });
});
