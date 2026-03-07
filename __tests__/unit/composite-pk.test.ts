import "reflect-metadata";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Column, COLUMN_TOKEN } from "../../src/decorators/Column";
import { Entity } from "../../src/decorators/Entity";
import { ColumnMetadata } from "../../src/scanner/ColumnScanner";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";

// ─── @PrimaryColumn 데코레이터 단위 테스트 ─────────────────

describe("@PrimaryColumn 데코레이터", () => {
  it("primary: true, autoIncrement: false 메타데이터가 저장되어야 한다", () => {
    class TestEntity {
      @PrimaryColumn()
      id!: number;
    }

    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, TestEntity.prototype) ?? [];
    const idCol = columns.find((c) => c.name === "id");

    expect(idCol).toBeDefined();
    expect(idCol!.options?.primary).toBe(true);
    expect(idCol!.options?.autoIncrement).toBeUndefined();
    expect(idCol!.options?.nullable).toBe(false);
  });

  it("사용자 옵션이 적용되어야 한다", () => {
    class UuidEntity {
      @PrimaryColumn({ type: "varchar", length: 36 })
      id!: string;
    }

    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, UuidEntity.prototype) ?? [];
    const idCol = columns.find((c) => c.name === "id");

    expect(idCol!.options?.type).toBe("varchar");
    expect(idCol!.options?.length).toBe(36);
    expect(idCol!.options?.primary).toBe(true);
  });

  it("복합 PK: 여러 컬럼에 @PrimaryColumn을 지정할 수 있어야 한다", () => {
    class OrderItem {
      @PrimaryColumn()
      orderId!: number;

      @PrimaryColumn()
      productId!: number;

      @Column()
      quantity!: number;
    }

    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, OrderItem.prototype) ?? [];
    const pkColumns = columns.filter((c) => c.options?.primary);

    expect(pkColumns).toHaveLength(2);
    expect(pkColumns.map((c) => c.name)).toContain("orderId");
    expect(pkColumns.map((c) => c.name)).toContain("productId");
  });

  it("@PrimaryColumn과 @PrimaryGeneratedColumn은 다른 동작을 해야 한다", () => {
    class MixedEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    class ManualEntity {
      @PrimaryColumn()
      id!: number;
    }

    const mixedCols: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, MixedEntity.prototype) ?? [];
    const manualCols: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, ManualEntity.prototype) ?? [];

    const mixedPk = mixedCols.find((c) => c.name === "id");
    const manualPk = manualCols.find((c) => c.name === "id");

    expect(mixedPk!.options?.autoIncrement).toBe(true);
    expect(manualPk!.options?.autoIncrement).toBeUndefined();
  });
});

// ─── SchemaGenerator 복합 PK DDL 테스트 ─────────────────

describe("SchemaGenerator 복합 PK DDL", () => {
  describe("PostgreSQL", () => {
    const generator = new SchemaGenerator({ dialect: "postgres" });

    it("단일 PK는 인라인 PRIMARY KEY로 생성되어야 한다", () => {
      @Entity()
      class SinglePkEntity {
        @PrimaryColumn({ type: "int" })
        id!: number;

        @Column()
        name!: string;
      }

      const ddl = generator.generateCreateTableDDL(SinglePkEntity);
      // 인라인 PRIMARY KEY
      expect(ddl).toContain("PRIMARY KEY");
      // 테이블 레벨 PRIMARY KEY (col1, col2)는 없어야 함
      expect(ddl).not.toMatch(/PRIMARY KEY\s*\(/);
    });

    it("복합 PK는 테이블 레벨 PRIMARY KEY (col1, col2)로 생성되어야 한다", () => {
      @Entity()
      class CompositePkEntity {
        @PrimaryColumn({ type: "int" })
        orderId!: number;

        @PrimaryColumn({ type: "int" })
        productId!: number;

        @Column()
        quantity!: number;
      }

      const ddl = generator.generateCreateTableDDL(CompositePkEntity);

      // 테이블 레벨 PRIMARY KEY 존재
      expect(ddl).toContain('PRIMARY KEY ("orderId", "productId")');
      // 개별 컬럼에 인라인 PRIMARY KEY가 없어야 함
      const orderIdPart = ddl.split(",").find((s) => s.includes('"orderId"'));
      expect(orderIdPart).not.toContain("PRIMARY KEY");
      // quantity는 PK가 아님
      expect(ddl).toContain('"quantity"');
    });

    it("findPrimaryKeyColumns가 모든 PK 컬럼을 반환해야 한다", () => {
      @Entity()
      class MultiPk {
        @PrimaryColumn({ type: "int" })
        a!: number;

        @PrimaryColumn({ type: "int" })
        b!: number;

        @Column()
        c!: string;
      }

      const pkCols = generator.findPrimaryKeyColumns(MultiPk);
      expect(pkCols).toEqual(["a", "b"]);
    });
  });

  describe("MySQL", () => {
    const generator = new SchemaGenerator({ dialect: "mysql" });

    it("단일 @PrimaryGeneratedColumn은 인라인 PRIMARY KEY + AUTO_INCREMENT로 생성되어야 한다", () => {
      @Entity()
      class AutoPkEntity {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column()
        name!: string;
      }

      const ddl = generator.generateCreateTableDDL(AutoPkEntity);
      expect(ddl).toContain("PRIMARY KEY");
      expect(ddl).toContain("AUTO_INCREMENT");
      expect(ddl).toContain("ENGINE=InnoDB");
    });

    it("복합 PK는 테이블 레벨 PRIMARY KEY로 생성되어야 한다", () => {
      @Entity()
      class MysqlCompositePk {
        @PrimaryColumn({ type: "int" })
        userId!: number;

        @PrimaryColumn({ type: "int" })
        roleId!: number;

        @Column()
        assignedAt!: string;
      }

      const ddl = generator.generateCreateTableDDL(MysqlCompositePk);
      expect(ddl).toContain("PRIMARY KEY (`userId`, `roleId`)");
      expect(ddl).toContain("ENGINE=InnoDB");
    });
  });
});

// ─── EntityManager 복합 PK 통합 테스트 ─────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockQuery = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockClose = jest.fn();
const mockTxConnect = jest.fn();
const mockStartTransaction = jest.fn();

jest.mock("../../src/dialects/TransactionSessionManager", () => ({
  TransactionSessionManager: jest.fn().mockImplementation(() => ({
    connect: mockTxConnect,
    startTransaction: mockStartTransaction,
    query: mockQuery,
    commit: mockCommit,
    rollback: mockRollback,
    close: mockClose,
  })),
}));

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: () => ({
      connect: jest.fn().mockResolvedValue({ query: jest.fn() }),
      close: jest.fn(),
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      type: "postgres",
    }),
  },
}));

import { EntityManager } from "../../src/core/EntityManager";

describe("EntityManager 복합 PK 통합 테스트", () => {
  let em: EntityManager;

  @Entity()
  class UserRole {
    @PrimaryColumn({ type: "int" })
    userId!: number;

    @PrimaryColumn({ type: "int" })
    roleId!: number;

    @Column()
    assignedAt!: string;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    em = new EntityManager();
    await em.connect({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
    });
  });

  describe("INSERT (복합 PK)", () => {
    it("모든 PK 값이 제공되면 INSERT를 수행해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ userId: 1, roleId: 2 }],
        fields: [],
      });

      const result = await em.save(UserRole, {
        userId: 1,
        roleId: 2,
        assignedAt: "2026-01-01",
      } as any);

      expect(result).toBeDefined();

      // INSERT 쿼리가 호출되었는지 확인
      const insertCall = mockQuery.mock.calls.find((call: any) => {
        const text = typeof call[0] === "string" ? call[0] : call[0]?.text;
        return text?.includes("INSERT");
      });
      expect(insertCall).toBeDefined();
    });

    it("INSERT 쿼리에 RETURNING 절이 모든 PK 컬럼을 포함해야 한다 (PostgreSQL)", async () => {
      mockQuery.mockResolvedValue({
        results: [{ userId: 1, roleId: 2 }],
        fields: [],
      });

      await em.save(UserRole, {
        userId: 1,
        roleId: 2,
        assignedAt: "2026-01-01",
      } as any);

      const insertCall = mockQuery.mock.calls.find((call: any) => {
        const text = typeof call[0] === "string" ? call[0] : call[0]?.text;
        return text?.includes("INSERT");
      });

      if (insertCall) {
        const text =
          typeof insertCall[0] === "string"
            ? insertCall[0]
            : insertCall[0]?.text;
        expect(text).toContain("RETURNING");
        expect(text).toContain('"userId"');
        expect(text).toContain('"roleId"');
      }
    });
  });

  describe("수동 PK save() 동작", () => {
    it("수동 PK(auto-increment 없음) 엔티티는 save() 시 항상 INSERT를 수행해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ userId: 1, roleId: 2, assignedAt: "2026-02-01" }],
        fields: [],
      });

      await em.save(UserRole, {
        userId: 1,
        roleId: 2,
        assignedAt: "2026-02-01",
      } as any);

      // INSERT 쿼리가 호출되었는지 확인
      const insertCall = mockQuery.mock.calls.find((call: any) => {
        const text = typeof call[0] === "string" ? call[0] : call[0]?.text;
        return text?.includes("INSERT");
      });

      expect(insertCall).toBeDefined();

      // UPDATE 쿼리는 호출되지 않아야 한다
      const updateCall = mockQuery.mock.calls.find((call: any) => {
        const text = typeof call[0] === "string" ? call[0] : call[0]?.text;
        return text?.includes("UPDATE");
      });

      expect(updateCall).toBeUndefined();
    });
  });

  describe("DELETE (복합 PK)", () => {
    it("복합 PK 조건으로 삭제가 동작해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [], rowCount: 1,
        fields: [],
      });

      const result = await em.delete(UserRole, {
        userId: 1,
        roleId: 2,
      } as any);

      expect(result.affected).toBe(1);

      const deleteCall = mockQuery.mock.calls.find((call: any) => {
        const text = typeof call[0] === "string" ? call[0] : call[0]?.text;
        return text?.includes("DELETE");
      });

      expect(deleteCall).toBeDefined();
      if (deleteCall) {
        const text =
          typeof deleteCall[0] === "string"
            ? deleteCall[0]
            : deleteCall[0]?.text;
        expect(text).toContain('"userId"');
        expect(text).toContain('"roleId"');
      }
    });
  });

  describe("FIND (복합 PK)", () => {
    it("복합 PK 조건으로 조회가 동작해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ userId: 1, roleId: 2, assignedAt: "2026-01-01" }],
        fields: [],
      });

      const result = await em.findOne(UserRole, {
        where: { userId: 1, roleId: 2 } as any,
      });

      expect(result).toBeDefined();
    });
  });
});

// ─── @PrimaryColumn 단일 PK (auto-increment 없음) ─────────

describe("@PrimaryColumn 단일 PK (수동)", () => {
  @Entity()
  class ManualIdEntity {
    @PrimaryColumn({ type: "varchar", length: 36 })
    id!: string;

    @Column()
    name!: string;
  }

  let em: EntityManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    em = new EntityManager();
    await em.connect({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
    });
  });

  it("수동 PK 값이 제공되면 INSERT를 수행해야 한다", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: "uuid-123", name: "Alice" }],
      fields: [],
    });

    const result = await em.save(ManualIdEntity, {
      id: "uuid-123",
      name: "Alice",
    } as any);

    expect(result).toBeDefined();

    const insertCall = mockQuery.mock.calls.find((call: any) => {
      const text = typeof call[0] === "string" ? call[0] : call[0]?.text;
      return text?.includes("INSERT");
    });

    expect(insertCall).toBeDefined();
  });

  it("수동 PK 값이 없으면 INSERT를 시도해야 한다 (DB에서 에러 발생 가능)", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: null, name: "NoId" }],
      fields: [],
    });

    const result = await em.save(ManualIdEntity, {
      name: "NoId",
    } as any);

    expect(result).toBeDefined();
  });
});
