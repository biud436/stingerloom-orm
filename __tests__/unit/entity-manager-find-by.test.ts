import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";

// EntityManager's constructor touches DatabaseClient via getters in some
// paths; mock it so a bare `new EntityManager()` is side-effect-free here.
jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

class User {}

describe("EntityManager.findBy / findOneBy (filter-first read shorthands)", () => {
  it("findOneBy delegates to findOne with the where wrapped in options", async () => {
    const em = new EntityManager();
    const spy = jest
      .spyOn(em, "findOne")
      .mockResolvedValue({ id: 1 } as any);

    const where = { id: 1 } as any;
    const result = await em.findOneBy(User, where);

    expect(spy).toHaveBeenCalledWith(User, { where });
    expect(result).toEqual({ id: 1 });
  });

  it("findBy delegates to find with the where wrapped in options", async () => {
    const em = new EntityManager();
    const spy = jest
      .spyOn(em, "find")
      .mockResolvedValue([{ id: 1 }] as any);

    const where = { role: "admin" } as any;
    const result = await em.findBy(User, where);

    expect(spy).toHaveBeenCalledWith(User, { where });
    expect(result).toEqual([{ id: 1 }]);
  });

  it("passes an OR array of where clauses straight through", async () => {
    const em = new EntityManager();
    const spy = jest.spyOn(em, "find").mockResolvedValue([] as any);

    const where = [{ id: 1 }, { id: 2 }] as any;
    await em.findBy(User, where);

    expect(spy).toHaveBeenCalledWith(User, { where });
  });

  it("is exposed on BaseRepository, delegating to the EntityManager", async () => {
    const em = new EntityManager();
    const findOneSpy = jest
      .spyOn(em, "findOne")
      .mockResolvedValue(null as any);
    const findSpy = jest.spyOn(em, "find").mockResolvedValue([] as any);

    const repo = new BaseRepository<User>(User, em);
    await repo.findOneBy({ id: 5 } as any);
    await repo.findBy({ id: 5 } as any);

    expect(findOneSpy).toHaveBeenCalledWith(User, { where: { id: 5 } });
    expect(findSpy).toHaveBeenCalledWith(User, { where: { id: 5 } });
  });
});
