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

    jest.spyOn(em, "find").mockResolvedValue(users as any);
    jest.spyOn(em, "count").mockResolvedValue(10);

    const result = await em.findAndCount(User);

    expect(result).toEqual([users, 10]);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toBe(users);
    expect(result[1]).toBe(10);
  });

  it("where 조건을 find()와 count() 모두에 전달해야 한다", async () => {
    const findSpy = jest.spyOn(em, "find").mockResolvedValue([] as any);
    const countSpy = jest.spyOn(em, "count").mockResolvedValue(0);

    const where = { name: "Alice" } as any;
    await em.findAndCount(User, { where });

    expect(findSpy).toHaveBeenCalledWith(User, { where });
    expect(countSpy).toHaveBeenCalledWith(User, where);
  });

  it("take/limit 옵션이 find()에만 영향을 미치고 count()에는 영향을 주지 않아야 한다", async () => {
    const findSpy = jest
      .spyOn(em, "find")
      .mockResolvedValue([{ id: 1, name: "Alice" }] as any);
    const countSpy = jest.spyOn(em, "count").mockResolvedValue(100);

    const findOption = { where: { name: "Alice" } as any, take: 10 };
    const [entities, count] = await em.findAndCount(User, findOption);

    expect(entities).toHaveLength(1);
    expect(count).toBe(100);
    expect(findSpy).toHaveBeenCalledWith(User, findOption);
    // count()는 where만 받으므로 take/limit은 전달되지 않음
    expect(countSpy).toHaveBeenCalledWith(User, findOption.where);
  });

  it("findOption 없이 호출하면 기본값을 사용해야 한다", async () => {
    const findSpy = jest.spyOn(em, "find").mockResolvedValue([] as any);
    const countSpy = jest.spyOn(em, "count").mockResolvedValue(0);

    const [entities, count] = await em.findAndCount(User);

    expect(entities).toEqual([]);
    expect(count).toBe(0);
    expect(findSpy).toHaveBeenCalledWith(User, {});
    expect(countSpy).toHaveBeenCalledWith(User, undefined);
  });

  it("find()와 count()를 병렬로 실행해야 한다", async () => {
    const callOrder: string[] = [];

    jest.spyOn(em, "find").mockImplementation(async () => {
      callOrder.push("find-start");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("find-end");
      return [] as any;
    });

    jest.spyOn(em, "count").mockImplementation(async () => {
      callOrder.push("count-start");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("count-end");
      return 0;
    });

    await em.findAndCount(User);

    // Promise.all이므로 두 작업이 모두 시작된 뒤 완료됨
    expect(callOrder[0]).toBe("find-start");
    expect(callOrder[1]).toBe("count-start");
  });

  it("find() 에러 시 에러를 전파해야 한다", async () => {
    jest.spyOn(em, "find").mockRejectedValue(new Error("find error"));
    jest.spyOn(em, "count").mockResolvedValue(0);

    await expect(em.findAndCount(User)).rejects.toThrow("find error");
  });

  it("count() 에러 시 에러를 전파해야 한다", async () => {
    jest.spyOn(em, "find").mockResolvedValue([] as any);
    jest.spyOn(em, "count").mockRejectedValue(new Error("count error"));

    await expect(em.findAndCount(User)).rejects.toThrow("count error");
  });

  it("orderBy, select, relations 등 모든 FindOption을 find()에 전달해야 한다", async () => {
    const findSpy = jest.spyOn(em, "find").mockResolvedValue([] as any);
    jest.spyOn(em, "count").mockResolvedValue(0);

    const findOption = {
      where: { name: "Alice" } as any,
      orderBy: { id: "DESC" } as any,
      select: { id: true, name: true } as any,
      relations: ["posts" as any],
      take: 5,
      cache: true,
    };

    await em.findAndCount(User, findOption);

    expect(findSpy).toHaveBeenCalledWith(User, findOption);
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
