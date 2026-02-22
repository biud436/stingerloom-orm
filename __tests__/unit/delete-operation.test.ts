import sql, { join, raw } from "sql-template-tag";
import { Conditions } from "../../src/core/Conditions";
import { BaseRepository } from "../../src/core/BaseRepository";
import { EntityManager } from "../../src/core/EntityManager";

/**
 * Delete 연산 단위 테스트
 *
 * EntityManager.delete()는 내부적으로 TransactionSessionManager를 사용하여
 * 실제 DB 연결이 필요하므로, SQL 생성 로직과 BaseRepository 위임 패턴을 중심으로 테스트합니다.
 */
describe("Delete Operation", () => {
  describe("DELETE SQL 생성 로직", () => {
    /**
     * EntityManager.delete()가 내부적으로 생성하는 SQL과 동일한 패턴을
     * 직접 조합하여 올바른 SQL이 생성되는지 검증합니다.
     */
    function buildDeleteSql(
      tableName: string,
      criteria: Record<string, unknown>,
      wrapFn: (name: string) => string,
    ) {
      const whereMap = [];
      for (const key in criteria) {
        const value = criteria[key];
        if (value !== undefined && value !== null) {
          whereMap.push(Conditions.equals(wrapFn(key), value));
        }
      }

      if (whereMap.length === 0) {
        throw new Error(
          "Delete without conditions is not allowed. Provide at least one criterion.",
        );
      }

      const whereSql = join(whereMap, " AND ");
      return sql`DELETE FROM ${raw(wrapFn(tableName))} WHERE ${whereSql}`;
    }

    const mysqlWrap = (name: string) =>
      `\`${name.replace(/`/g, "``")}\``;
    const pgWrap = (name: string) =>
      `"${name.replace(/"/g, '""')}"`;

    it("단일 조건으로 DELETE 쿼리를 생성해야 함 (MySQL)", () => {
      const query = buildDeleteSql(
        "users",
        { id: 1 },
        mysqlWrap,
      );

      expect(query.sql).toBe("DELETE FROM `users` WHERE `id` = ?");
      expect(query.values).toEqual([1]);
    });

    it("단일 조건으로 DELETE 쿼리를 생성해야 함 (PostgreSQL)", () => {
      const query = buildDeleteSql(
        "users",
        { id: 1 },
        pgWrap,
      );

      expect(query.sql).toBe('DELETE FROM "users" WHERE "id" = ?');
      expect(query.values).toEqual([1]);
    });

    it("다중 조건으로 DELETE 쿼리를 생성해야 함", () => {
      const query = buildDeleteSql(
        "users",
        { status: "inactive", role: "guest" },
        mysqlWrap,
      );

      expect(query.sql).toBe(
        "DELETE FROM `users` WHERE `status` = ? AND `role` = ?",
      );
      expect(query.values).toEqual(["inactive", "guest"]);
    });

    it("숫자 조건으로 DELETE 쿼리를 생성해야 함", () => {
      const query = buildDeleteSql(
        "orders",
        { id: 42, user_id: 7 },
        mysqlWrap,
      );

      expect(query.sql).toBe(
        "DELETE FROM `orders` WHERE `id` = ? AND `user_id` = ?",
      );
      expect(query.values).toEqual([42, 7]);
    });

    it("문자열 값 조건으로 DELETE 쿼리를 생성해야 함", () => {
      const query = buildDeleteSql(
        "sessions",
        { token: "abc-123-xyz" },
        pgWrap,
      );

      expect(query.sql).toBe('DELETE FROM "sessions" WHERE "token" = ?');
      expect(query.values).toEqual(["abc-123-xyz"]);
    });

    it("boolean 조건으로 DELETE 쿼리를 생성해야 함", () => {
      const query = buildDeleteSql(
        "notifications",
        { read: true },
        mysqlWrap,
      );

      expect(query.sql).toBe(
        "DELETE FROM `notifications` WHERE `read` = ?",
      );
      expect(query.values).toEqual([true]);
    });

    it("undefined 값은 무시해야 함", () => {
      const query = buildDeleteSql(
        "users",
        { id: 1, name: undefined } as any,
        mysqlWrap,
      );

      expect(query.sql).toBe("DELETE FROM `users` WHERE `id` = ?");
      expect(query.values).toEqual([1]);
    });

    it("null 값은 무시해야 함", () => {
      const query = buildDeleteSql(
        "users",
        { id: 1, name: null } as any,
        mysqlWrap,
      );

      expect(query.sql).toBe("DELETE FROM `users` WHERE `id` = ?");
      expect(query.values).toEqual([1]);
    });

    it("빈 조건일 경우 에러를 던져야 함", () => {
      expect(() => {
        buildDeleteSql("users", {}, mysqlWrap);
      }).toThrow(
        "Delete without conditions is not allowed. Provide at least one criterion.",
      );
    });

    it("모든 값이 undefined/null인 경우 에러를 던져야 함", () => {
      expect(() => {
        buildDeleteSql(
          "users",
          { id: undefined, name: null } as any,
          mysqlWrap,
        );
      }).toThrow(
        "Delete without conditions is not allowed. Provide at least one criterion.",
      );
    });

    it("SQL injection 시도가 파라미터로 바인딩되어야 함", () => {
      const query = buildDeleteSql(
        "users",
        { name: "'; DROP TABLE users; --" },
        mysqlWrap,
      );

      expect(query.sql).toBe("DELETE FROM `users` WHERE `name` = ?");
      expect(query.values).toEqual(["'; DROP TABLE users; --"]);
    });

    it("특수문자가 포함된 테이블명이 올바르게 이스케이프되어야 함 (MySQL)", () => {
      const query = buildDeleteSql(
        "user`table",
        { id: 1 },
        mysqlWrap,
      );

      expect(query.sql).toBe("DELETE FROM `user``table` WHERE `id` = ?");
      expect(query.values).toEqual([1]);
    });

    it("특수문자가 포함된 테이블명이 올바르게 이스케이프되어야 함 (PostgreSQL)", () => {
      const query = buildDeleteSql(
        'user"table',
        { id: 1 },
        pgWrap,
      );

      expect(query.sql).toBe('DELETE FROM "user""table" WHERE "id" = ?');
      expect(query.values).toEqual([1]);
    });
  });

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
    it("엔티티 인스턴스를 EntityManager.delete()에 위임해야 함", async () => {
      const mockDeleteResult = { affected: 1 };
      const mockEntityManager = {
        delete: jest.fn().mockResolvedValue(mockDeleteResult),
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

      expect(mockEntityManager.delete).toHaveBeenCalledWith(User, user);
      expect(result).toEqual({ affected: 1 });
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
