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

    // findAndCount는 내부적으로 findInternal + aggregate를 사용합니다.
    jest.spyOn(em as any, "findInternal").mockResolvedValue(users as any);
    jest.spyOn(em as any, "aggregate").mockResolvedValue(10);
    // executeInTransaction을 우회하여 세션 없이 콜백 실행
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
      async (fn: any) => fn({}),
    );

    const result = await em.findAndCount(User);

    expect(result).toEqual([users, 10]);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toBe(users);
    expect(result[1]).toBe(10);
  });

  it("where 조건을 findInternal()와 aggregate() 모두에 전달해야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    const aggregateSpy = jest
      .spyOn(em as any, "aggregate")
      .mockResolvedValue(0);
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
      async (fn: any) => fn({}),
    );

    const where = { name: "Alice" } as any;
    await em.findAndCount(User, { where });

    expect(findInternalSpy).toHaveBeenCalledWith(User, { where }, {});
    expect(aggregateSpy).toHaveBeenCalledWith(User, "COUNT", "*", where, {});
  });

  it("take/limit 옵션이 findInternal()에만 영향을 미치고 aggregate()에는 영향을 주지 않아야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([{ id: 1, name: "Alice" }] as any);
    const aggregateSpy = jest
      .spyOn(em as any, "aggregate")
      .mockResolvedValue(100);
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
      async (fn: any) => fn({}),
    );

    const findOption = { where: { name: "Alice" } as any, take: 10 };
    const [entities, count] = await em.findAndCount(User, findOption);

    expect(entities).toHaveLength(1);
    expect(count).toBe(100);
    expect(findInternalSpy).toHaveBeenCalledWith(User, findOption, {});
    // aggregate는 where만 전달됨 (take/limit 무시)
    expect(aggregateSpy).toHaveBeenCalledWith(
      User,
      "COUNT",
      "*",
      findOption.where,
      {},
    );
  });

  it("findOption 없이 호출하면 기본값을 사용해야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    const aggregateSpy = jest
      .spyOn(em as any, "aggregate")
      .mockResolvedValue(0);
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
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
    );
  });

  it("findInternal()와 aggregate()를 동일한 세션으로 실행해야 한다", async () => {
    const mockSession = { id: "mock-session" };
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    const aggregateSpy = jest
      .spyOn(em as any, "aggregate")
      .mockResolvedValue(0);
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
      async (fn: any) => fn(mockSession),
    );

    await em.findAndCount(User);

    // 두 호출 모두 동일한 세션을 받아야 합니다
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
    );
  });

  it("findInternal() 에러 시 에러를 전파해야 한다", async () => {
    jest
      .spyOn(em as any, "findInternal")
      .mockRejectedValue(new Error("find error"));
    jest.spyOn(em as any, "aggregate").mockResolvedValue(0);
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
      async (fn: any) => fn({}),
    );

    await expect(em.findAndCount(User)).rejects.toThrow("find error");
  });

  it("aggregate() 에러 시 에러를 전파해야 한다", async () => {
    jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    jest
      .spyOn(em as any, "aggregate")
      .mockRejectedValue(new Error("count error"));
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
      async (fn: any) => fn({}),
    );

    await expect(em.findAndCount(User)).rejects.toThrow("count error");
  });

  it("orderBy, select, relations 등 모든 FindOption을 findInternal()에 전달해야 한다", async () => {
    const findInternalSpy = jest
      .spyOn(em as any, "findInternal")
      .mockResolvedValue([] as any);
    jest.spyOn(em as any, "aggregate").mockResolvedValue(0);
    jest.spyOn(em as any, "executeInTransaction").mockImplementation(
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
