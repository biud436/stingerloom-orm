/**
 * S-1 트랜잭션 롤백 통합 테스트
 *
 * TransactionSessionManager를 사용하여 수동 트랜잭션의
 * 커밋/롤백 동작을 검증합니다.
 *
 * EntityManager의 각 CRUD 메서드는 내부적으로 개별 트랜잭션을 생성하므로,
 * 수동 트랜잭션 제어는 TransactionSessionManager를 직접 사용해야 합니다.
 *
 * 실행:
 *   INTEGRATION_TEST=true pnpm test -- --testPathPattern="p3-transaction"
 */

import "reflect-metadata";
import sql, { raw } from "sql-template-tag";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;
const describeIf = skipReason ? describe.skip : describe;

/**
 * em.find() 결과를 배열로 정규화합니다.
 * find()는 결과가 1개일 때 단일 객체, 0개일 때 undefined, 여러 개일 때 배열을 반환합니다.
 */
function toArray<T>(result: any): T[] {
  if (result === undefined || result === null) return [];
  if (Array.isArray(result)) return result;
  return [result];
}

describeIf("[S-1] 트랜잭션 롤백 통합 테스트", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        testEntity = createCrudTestEntity("txn_rollback_test");
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;
  }, 30000);

  afterAll(async () => {
    try {
      await dropTestTable(testEntity.tableName);
    } catch {
      // ignore
    }
    if (conn) await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    await truncateTestTable(testEntity.tableName);
  });

  // ─── S-1 Basic: 수동 트랜잭션 롤백 ───────────────────────────────────────

  describe("수동 트랜잭션 롤백 (TransactionSessionManager)", () => {
    it("롤백하면 INSERT된 엔티티가 DB에 존재하지 않아야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tableName = testEntity.tableName;
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`, \`email\`)
              VALUES (${"RolledBack"}, ${99}, ${"rollback@test.com"})`,
        );

        // 롤백
        await session.rollback();
      } finally {
        await session.close();
      }

      // DB에서 확인 — 엔티티가 존재하지 않아야 함
      const result = await em.find(testEntity.EntityClass, {
        where: { name: "RolledBack" },
      });
      const found = toArray(result);
      expect(found).toHaveLength(0);
    });

    it("커밋하면 INSERT된 엔티티가 DB에 존재해야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tableName = testEntity.tableName;
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`, \`email\`)
              VALUES (${"Committed"}, ${30}, ${"commit@test.com"})`,
        );

        await session.commit();
      } finally {
        await session.close();
      }

      // DB에서 확인 — 엔티티가 존재해야 함
      const result = await em.findOne(testEntity.EntityClass, {
        where: { name: "Committed" },
      });
      expect(result).toBeDefined();
      expect(result!.name).toBe("Committed");
      expect(result!.age).toBe(30);
      expect(result!.email).toBe("commit@test.com");
    });
  });

  // ─── S-1 Multiple: 여러 INSERT 후 롤백 ────────────────────────────────────

  describe("여러 INSERT 후 롤백", () => {
    it("2개의 INSERT 후 롤백하면 둘 다 DB에 존재하지 않아야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tableName = testEntity.tableName;

        // 엔티티 A INSERT
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"EntityA"}, ${25})`,
        );

        // 엔티티 B INSERT
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"EntityB"}, ${35})`,
        );

        // 롤백
        await session.rollback();
      } finally {
        await session.close();
      }

      // 둘 다 존재하지 않아야 함
      const foundA = toArray(
        await em.find(testEntity.EntityClass, { where: { name: "EntityA" } }),
      );
      const foundB = toArray(
        await em.find(testEntity.EntityClass, { where: { name: "EntityB" } }),
      );
      expect(foundA).toHaveLength(0);
      expect(foundB).toHaveLength(0);
    });

    it("2개의 INSERT 후 커밋하면 둘 다 DB에 존재해야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tableName = testEntity.tableName;

        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"CommitA"}, ${40})`,
        );

        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"CommitB"}, ${50})`,
        );

        await session.commit();
      } finally {
        await session.close();
      }

      const resultA = await em.findOne(testEntity.EntityClass, {
        where: { name: "CommitA" },
      });
      const resultB = await em.findOne(testEntity.EntityClass, {
        where: { name: "CommitB" },
      });
      expect(resultA).toBeDefined();
      expect(resultA!.name).toBe("CommitA");
      expect(resultA!.age).toBe(40);
      expect(resultB).toBeDefined();
      expect(resultB!.name).toBe("CommitB");
      expect(resultB!.age).toBe(50);
    });
  });

  // ─── S-1 에러 시 롤백 ──────────────────────────────────────────────────────

  describe("에러 발생 시 롤백 패턴", () => {
    it("INSERT 후 에러가 발생하면 try/catch에서 롤백하여 데이터가 없어야 한다", async () => {
      const session = new TransactionSessionManager();
      let errorOccurred = false;

      try {
        await session.connect();
        await session.startTransaction();

        const tableName = testEntity.tableName;

        // 유효한 INSERT
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"WillRollback"}, ${20})`,
        );

        // 의도적으로 에러 발생 (존재하지 않는 테이블에 INSERT)
        await session.query(
          sql`INSERT INTO ${raw("`nonexistent_table_xyz`")} (\`col\`) VALUES (${"x"})`,
        );
      } catch {
        errorOccurred = true;
        await session.rollback();
      } finally {
        await session.close();
      }

      expect(errorOccurred).toBe(true);

      // 유효했던 첫 번째 INSERT도 롤백되어야 함
      const found = toArray(
        await em.find(testEntity.EntityClass, {
          where: { name: "WillRollback" },
        }),
      );
      expect(found).toHaveLength(0);
    });
  });

  // ─── S-1 Savepoint ──────────────────────────────────────────────────────

  describe("Savepoint 롤백", () => {
    it("savepoint까지만 롤백하면 이전 INSERT는 유지되어야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tableName = testEntity.tableName;

        // 첫 번째 INSERT
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"BeforeSavepoint"}, ${10})`,
        );

        // Savepoint 생성
        await session.savepoint("sp1");

        // 두 번째 INSERT (savepoint 이후)
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"AfterSavepoint"}, ${20})`,
        );

        // Savepoint로 롤백
        await session.rollbackTo("sp1");

        // 커밋
        await session.commit();
      } finally {
        await session.close();
      }

      // savepoint 이전 INSERT는 유지
      const beforeResult = await em.findOne(testEntity.EntityClass, {
        where: { name: "BeforeSavepoint" },
      });
      expect(beforeResult).toBeDefined();
      expect(beforeResult!.name).toBe("BeforeSavepoint");

      // savepoint 이후 INSERT는 롤백됨
      const afterResult = toArray(
        await em.find(testEntity.EntityClass, {
          where: { name: "AfterSavepoint" },
        }),
      );
      expect(afterResult).toHaveLength(0);
    });
  });

  // ─── S-1 EntityManager save() 자동 커밋 검증 ──────────────────────────────

  describe("EntityManager save()는 자동 커밋", () => {
    it("save()로 저장한 엔티티는 개별 트랜잭션으로 커밋되어 즉시 조회 가능해야 한다", async () => {
      const repo = em.getRepository(testEntity.EntityClass);

      const saved = await repo.save({
        name: "AutoCommitted",
        age: 42,
        email: "auto@test.com",
      });

      expect(saved.id).toBeDefined();

      // 별도 세션에서 조회해도 존재해야 함 (자동 커밋 되었으므로)
      const result = await em.findOne(testEntity.EntityClass, {
        where: { name: "AutoCommitted" },
      });
      expect(result).toBeDefined();
      expect(result!.name).toBe("AutoCommitted");
    });
  });

  // ─── S-1 격리 수준 ──────────────────────────────────────────────────────

  describe("트랜잭션 격리 수준 설정", () => {
    it("SERIALIZABLE 격리 수준으로 트랜잭션을 시작할 수 있어야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction("SERIALIZABLE");

        const tableName = testEntity.tableName;
        await session.query(
          sql`INSERT INTO ${raw(`\`${tableName}\``)} (\`name\`, \`age\`)
              VALUES (${"Serializable"}, ${60})`,
        );

        await session.commit();
      } finally {
        await session.close();
      }

      const result = await em.findOne(testEntity.EntityClass, {
        where: { name: "Serializable" },
      });
      expect(result).toBeDefined();
      expect(result!.name).toBe("Serializable");
    });
  });
});
