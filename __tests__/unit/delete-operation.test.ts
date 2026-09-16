import { BaseRepository } from "../../src/core/BaseRepository";
import { EntityManager } from "../../src/core/EntityManager";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

/**
 * Delete operation unit tests — BaseRepository delegation only.
 *
 * The DELETE criteria contract (AND composition, undefined skipped,
 * null → IS NULL, DeleteWithoutConditionsError, parameter binding) is
 * verified against the SHIPPED builder (WriteExecutor.deleteEntity →
 * resolveWhereClause) with real SQL in
 * __tests__/integration/sqlite/delete-operation.test.ts. A locally
 * re-declared `buildDeleteSql` copy used to be asserted here; it had
 * drifted from the real contract (it dropped `null` criteria, which the
 * shipped resolver turns into IS NULL) and was removed (issue #404).
 */
describe("Delete Operation", () => {
  describe("BaseRepository.delete() 위임", () => {
    it("EntityManager.delete()에 올바르게 위임해야 함", async () => {
      const mockDeleteResult = { affected: 3 };
      const mockEntityManager = {
        delete: jest.fn().mockResolvedValue(mockDeleteResult),
      } as unknown as EntityManager;

      class User {
        id!: number;
        name!: string;
      }

      const repo = BaseRepository.of(User, mockEntityManager);
      const result = await repo.delete({ id: 1 } as any);

      expect(mockEntityManager.delete).toHaveBeenCalledWith(User, { id: 1 });
      expect(result).toEqual({ affected: 3 });
    });

    it("빈 결과도 올바르게 반환해야 함", async () => {
      const mockDeleteResult = { affected: 0 };
      const mockEntityManager = {
        delete: jest.fn().mockResolvedValue(mockDeleteResult),
      } as unknown as EntityManager;

      class Order {
        id!: number;
      }

      const repo = BaseRepository.of(Order, mockEntityManager);
      const result = await repo.delete({ id: 999 } as any);

      expect(result).toEqual({ affected: 0 });
    });
  });

  describe("BaseRepository.remove() 위임", () => {
    const column = (propertyKey: string, primary: boolean) => ({
      propertyKey,
      columnName: propertyKey,
      type: "varchar",
      nullable: false,
      primary,
      unique: false,
    });

    it("기본 키 컬럼만 조건으로 EntityManager.delete()에 위임해야 함", async () => {
      const mockDeleteResult = { affected: 1 };
      const mockEntityManager = {
        delete: jest.fn().mockResolvedValue(mockDeleteResult),
        getColumnMetadata: jest
          .fn()
          .mockReturnValue([column("id", true), column("name", false)]),
      } as unknown as EntityManager;

      class User {
        id!: number;
        name!: string;
      }

      const repo = BaseRepository.of(User, mockEntityManager);
      const user = new User();
      user.id = 5;
      user.name = "John";

      const result = await repo.remove(user);

      expect(mockEntityManager.delete).toHaveBeenCalledWith(User, { id: 5 });
      expect(result).toEqual({ affected: 1 });
    });

    it("기본 키가 없는 인스턴스는 InvalidQueryError를 던지고 delete()를 호출하지 않아야 함", async () => {
      const mockEntityManager = {
        delete: jest.fn(),
        getColumnMetadata: jest
          .fn()
          .mockReturnValue([column("id", true), column("name", false)]),
      } as unknown as EntityManager;

      class User {
        id!: number;
        name!: string;
      }

      const repo = BaseRepository.of(User, mockEntityManager);
      const user = new User();
      user.name = "John";

      await expect(repo.remove(user)).rejects.toThrow(InvalidQueryError);
      expect(mockEntityManager.delete).not.toHaveBeenCalled();
    });

    it("기본 키 컬럼이 없는 엔티티는 인스턴스 전체를 조건으로 넘겨야 함", async () => {
      const mockEntityManager = {
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
        getColumnMetadata: jest.fn().mockReturnValue([column("name", false)]),
      } as unknown as EntityManager;

      class Log {
        name!: string;
      }

      const repo = BaseRepository.of(Log, mockEntityManager);
      const log = new Log();
      log.name = "boot";

      await repo.remove(log);

      expect(mockEntityManager.delete).toHaveBeenCalledWith(Log, log);
    });
  });

  describe("DeleteResult 타입", () => {
    it("affected 필드를 포함해야 함", () => {
      const result = { affected: 5 };
      expect(result.affected).toBe(5);
    });

    it("affected가 0일 수 있어야 함", () => {
      const result = { affected: 0 };
      expect(result.affected).toBe(0);
    });
  });
});
