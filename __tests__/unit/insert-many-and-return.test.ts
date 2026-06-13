/**
 * insertManyAndReturn() 테스트
 *
 * insertMany()와 동일한 멀티 행 INSERT를 만들되 RETURNING * 절을 덧붙여
 * 생성된 PK / DB 기본값이 채워진 엔티티 인스턴스를 입력 순서대로 반환하는지
 * 검증합니다.
 *
 * - RETURNING 지원 드라이버(PostgreSQL/SQLite 3.35+/MariaDB 10.5+):
 *   SQL에 RETURNING 포함 + 반환 행을 엔티티 인스턴스로 역직렬화
 * - 미지원 드라이버(MySQL): SQL을 만들기 전에 OrmError(UNSUPPORTED_DATABASE)
 *   throw + INSERT 미발행
 * - 빈 배열: 쿼리 없이 [] 반환
 * - BaseRepository.insertManyAndReturn 위임
 */
import "reflect-metadata";

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "postgres",
        getType: jest.fn().mockReturnValue("postgres"),
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

@Entity({ name: "widget" })
class Widget {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  // Explicit DB column name → exercises ResultTransformer reverse mapping
  // (full_name → fullName) on the RETURNING rows.
  @Column({ type: "varchar", name: "full_name" })
  fullName!: string;
}

const widgetMetadata = {
  name: "widget",
  target: Widget,
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", propertyKey: "name", options: {} },
    { name: "full_name", propertyKey: "fullName", options: {} },
  ],
};

function setupResolverMocks(em: EntityManager, metadata: any = widgetMetadata) {
  jest
    .spyOn((em as any).resolver, "resolveEntityMetadata")
    .mockImplementation((entity: any) =>
      entity === metadata.target ? metadata : null,
    );
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveManyToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "getVersionColumn").mockReturnValue(null);
}

function createReturningEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `"${name}"`,
    supportsExplain: () => false,
    supportsReturning: () => true,
    supportsInsertReturning: () => true,
  };
  (em as any).dbType = "postgres";
  setupResolverMocks(em);
  return em;
}

function createNoReturningEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
    supportsReturning: () => false,
    supportsInsertReturning: () => false,
  };
  (em as any).dbType = "mysql";
  setupResolverMocks(em);
  return em;
}

function getSqlText(call: any[]): string {
  const sqlObj = call[0];
  return sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
}

function findInsertCall() {
  return mockQuery.mock.calls.find((call: any[]) =>
    getSqlText(call).includes("INSERT"),
  );
}

describe("insertManyAndReturn() — RETURNING 지원 드라이버", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createReturningEntityManager();
    // RETURNING * 가 돌려주는 DB 컬럼명 기반 행 (입력 순서 유지)
    mockQuery.mockResolvedValue({
      results: [
        { id: 10, name: "a", full_name: "Alpha" },
        { id: 11, name: "b", full_name: "Beta" },
      ],
      fields: [],
    });
  });

  it("생성된 SQL에 RETURNING이 포함되어야 한다", async () => {
    await em.insertManyAndReturn(Widget, [
      { name: "a", fullName: "Alpha" } as any,
      { name: "b", fullName: "Beta" } as any,
    ]);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!).replace(/\s+/g, " ");
    expect(insertSql).toContain("INSERT INTO");
    expect(insertSql).toContain("RETURNING *");
  });

  it("반환된 행을 엔티티 인스턴스로 역직렬화하고 입력 순서를 유지해야 한다", async () => {
    const results = await em.insertManyAndReturn(Widget, [
      { name: "a", fullName: "Alpha" } as any,
      { name: "b", fullName: "Beta" } as any,
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeInstanceOf(Widget);
    expect(results[1]).toBeInstanceOf(Widget);
    // 생성된 PK가 채워져 있어야 한다
    expect(results[0].id).toBe(10);
    expect(results[1].id).toBe(11);
    // 입력 순서 유지
    expect(results[0].name).toBe("a");
    expect(results[1].name).toBe("b");
    // RETURNING 컬럼명(full_name) → 속성명(fullName) 역매핑
    expect(results[0].fullName).toBe("Alpha");
    expect(results[1].fullName).toBe("Beta");
  });

  it("빈 배열이면 쿼리 없이 빈 배열을 반환해야 한다", async () => {
    const results = await em.insertManyAndReturn(Widget, []);
    expect(results).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("insertManyAndReturn() — RETURNING 미지원 드라이버(MySQL)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createNoReturningEntityManager();
  });

  it("명확한 OrmError(UNSUPPORTED_DATABASE)를 throw하고 INSERT를 발행하지 않아야 한다", async () => {
    expect.assertions(4);
    try {
      await em.insertManyAndReturn(Widget, [{ name: "a", fullName: "Alpha" } as any]);
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_DATABASE);
      expect((e as OrmError).message).toContain("insertManyAndReturn()");
    }
    // SQL을 만들기 전에 실패 → INSERT 미발행
    expect(findInsertCall()).toBeUndefined();
  });

  it("빈 배열은 미지원 드라이버여도 쿼리/에러 없이 빈 배열을 반환해야 한다", async () => {
    const results = await em.insertManyAndReturn(Widget, []);
    expect(results).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("BaseRepository.insertManyAndReturn() 위임", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createReturningEntityManager();
    mockQuery.mockResolvedValue({
      results: [
        { id: 10, name: "a", full_name: "Alpha" },
        { id: 11, name: "b", full_name: "Beta" },
      ],
      fields: [],
    });
  });

  it("EntityManager.insertManyAndReturn으로 위임하고 동일한 배열을 반환해야 한다", async () => {
    const repo = new BaseRepository<Widget>(Widget, em);
    const spy = jest.spyOn(em, "insertManyAndReturn");

    const results = await repo.insertManyAndReturn([
      { name: "a", fullName: "Alpha" } as any,
      { name: "b", fullName: "Beta" } as any,
    ]);

    expect(spy).toHaveBeenCalledWith(Widget, [
      { name: "a", fullName: "Alpha" },
      { name: "b", fullName: "Beta" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toBeInstanceOf(Widget);
    expect(results[0].id).toBe(10);
    expect(results[1].id).toBe(11);
  });
});
