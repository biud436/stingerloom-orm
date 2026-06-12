/**
 * Issue #368: save()/insert가 값이 없는(undefined) 컬럼을 INSERT 컬럼 목록에서
 * 생략하는지 검증합니다.
 *
 * - undefined = "값 미제공" → 컬럼 생략 → DB DEFAULT / @Column({ default }) 적용
 * - 명시적 null → 컬럼 포함 + NULL 바인딩
 * - @CreateTimestamp / @UpdateTimestamp / @Version / UUID 생성 컬럼은
 *   자동 주입되므로 undefined여도 유지
 */
import "reflect-metadata";

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getType: jest.fn().mockReturnValue("mysql"),
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
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

@Entity({ name: "category368" })
class Category368 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "int" })
  lft!: number;

  @Column({ type: "int" })
  rgt!: number;

  @Column({ type: "int", nullable: false, default: 1, name: "group_id" })
  groupId!: number;
}

const categoryMetadata = {
  name: "category368",
  target: Category368,
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", propertyKey: "name", options: {} },
    { name: "lft", propertyKey: "lft", options: {} },
    { name: "rgt", propertyKey: "rgt", options: {} },
    { name: "group_id", propertyKey: "groupId", options: { nullable: false, default: 1 } },
  ],
};

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };
  (em as any).dbType = "mysql";
  return em;
}

function setupMocks(em: EntityManager, metadata: any = categoryMetadata) {
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

describe("save() INSERT — undefined 컬럼 생략 (#368)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
    mockQuery.mockResolvedValue({ results: { insertId: 1 }, fields: [] });
  });

  it("partial save 시 undefined인 컬럼은 INSERT 컬럼 목록에서 빠져야 한다", async () => {
    await em.save(Category368, { name: "root", lft: 1, rgt: 2 } as any);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`name`");
    expect(insertSql).toContain("`lft`");
    expect(insertSql).toContain("`rgt`");
    // 핵심: group_id가 빠져야 DB DEFAULT 1이 적용된다
    expect(insertSql).not.toContain("`group_id`");
    expect(insertCall![0].values).not.toContain(null);
  });

  it("명시적 null은 여전히 NULL로 바인딩되어야 한다", async () => {
    await em.save(Category368, {
      name: "root",
      lft: 1,
      rgt: 2,
      groupId: null,
    } as any);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`group_id`");
    expect(insertCall![0].values).toContain(null);
  });

  it("값이 제공된 컬럼은 그대로 포함되어야 한다", async () => {
    await em.save(Category368, {
      name: "root",
      lft: 1,
      rgt: 2,
      groupId: 7,
    } as any);

    const insertCall = findInsertCall();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`group_id`");
    expect(insertCall![0].values).toContain(7);
  });

  it("0/빈 문자열/false 같은 falsy 값은 생략하지 않아야 한다", async () => {
    await em.save(Category368, {
      name: "",
      lft: 0,
      rgt: 0,
      groupId: 0,
    } as any);

    const insertCall = findInsertCall();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`name`");
    expect(insertSql).toContain("`lft`");
    expect(insertSql).toContain("`group_id`");
    expect(insertCall![0].values).toEqual(expect.arrayContaining([0, ""]));
  });
});

describe("save() INSERT — 자동 주입 컬럼은 undefined여도 유지 (#368)", () => {
  let em: EntityManager;

  const metadataWithAutoCols = {
    name: "category368",
    target: Category368,
    columns: [
      ...categoryMetadata.columns,
      { name: "created_at", propertyKey: "createdAt", options: {} },
      { name: "updated_at", propertyKey: "updatedAt", options: {} },
      { name: "version", propertyKey: "version", options: {} },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em, metadataWithAutoCols);
    jest
      .spyOn((em as any).resolver, "getCreateTimestampColumn")
      .mockReturnValue("created_at");
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue("updated_at");
    jest
      .spyOn((em as any).resolver, "getVersionColumn")
      .mockReturnValue("version");
    mockQuery.mockResolvedValue({ results: { insertId: 1 }, fields: [] });
  });

  it("@CreateTimestamp/@UpdateTimestamp/@Version 컬럼은 INSERT에 포함되고 값이 주입되어야 한다", async () => {
    await em.save(Category368, { name: "root", lft: 1, rgt: 2 } as any);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`created_at`");
    expect(insertSql).toContain("`updated_at`");
    expect(insertSql).toContain("`version`");
    // 버전 자동 초기화
    expect(insertCall![0].values).toContain(1);
    // 타임스탬프 자동 주입 (NULL이 아님)
    expect(insertCall![0].values).not.toContain(null);
    // group_id는 여전히 생략
    expect(insertSql).not.toContain("`group_id`");
  });
});

describe("save() INSERT — 모든 컬럼 생략 엣지 케이스 (#368)", () => {
  @Entity({ name: "pk_only368" })
  class PkOnly368 {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", nullable: true })
    note!: string;
  }

  const pkOnlyMetadata = {
    name: "pk_only368",
    target: PkOnly368,
    columns: [
      { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
      { name: "note", propertyKey: "note", options: { nullable: true } },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("MySQL: 모든 컬럼이 undefined면 () VALUES () 형태가 되어야 한다", async () => {
    const em = createTestEntityManager();
    setupMocks(em, pkOnlyMetadata);
    mockQuery.mockResolvedValue({ results: { insertId: 1 }, fields: [] });

    await em.save(PkOnly368, {} as any);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!).replace(/\s+/g, " ");
    expect(insertSql).toContain("() VALUES ()");
  });

  it("PostgreSQL: 모든 컬럼이 undefined면 DEFAULT VALUES가 되어야 한다", async () => {
    const em = new EntityManager();
    (em as any).driver = {
      wrap: (name: string) => `"${name}"`,
      supportsExplain: () => false,
      supportsReturning: () => true,
    };
    (em as any).dbType = "postgres";
    setupMocks(em, pkOnlyMetadata);
    mockQuery.mockResolvedValue({
      results: [{ id: 1, note: null }],
      fields: [],
    });

    await em.save(PkOnly368, {} as any);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!).replace(/\s+/g, " ");
    expect(insertSql).toContain("DEFAULT VALUES");
    expect(insertSql).not.toContain("()");
  });
});

describe("saveMany() batch INSERT — 어떤 아이템도 제공하지 않는 컬럼 생략 (#368)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("모든 아이템에서 undefined인 컬럼은 batch INSERT에서 빠져야 한다", async () => {
    mockQuery.mockResolvedValue({ results: { insertId: 1 }, fields: [] });

    await em.saveMany(Category368, [
      { name: "a", lft: 1, rgt: 2 } as any,
      { name: "b", lft: 3, rgt: 4 } as any,
    ]);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`name`");
    expect(insertSql).not.toContain("`group_id`");
  });

  it("한 아이템이라도 값을 제공하면 컬럼은 유지되어야 한다", async () => {
    mockQuery.mockResolvedValue({ results: { insertId: 1 }, fields: [] });

    await em.saveMany(Category368, [
      { name: "a", lft: 1, rgt: 2 } as any,
      { name: "b", lft: 3, rgt: 4, groupId: 5 } as any,
    ]);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`group_id`");
  });
});

/**
 * Issue #373: saveMany()의 모든 아이템에서 모든 insertable 컬럼이 생략되고 FK
 * 컬럼도 없는 경우, batch INSERT가 `() VALUES (), ()` 형태가 됩니다. 이는
 * MySQL 계열에서만 유효하며, PostgreSQL/SQLite는 다이얼렉트별 all-default
 * 형태가 필요합니다.
 */
describe("saveMany() batch INSERT — 모든 컬럼 생략 엣지 케이스 (#373)", () => {
  @Entity({ name: "pk_only373" })
  class PkOnly373 {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", nullable: true })
    note!: string;
  }

  const pkOnlyMetadata = {
    name: "pk_only373",
    target: PkOnly373,
    columns: [
      { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
      { name: "note", propertyKey: "note", options: { nullable: true } },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("MySQL: 모든 컬럼이 undefined인 batch는 () VALUES (), () 형태여야 한다", async () => {
    const em = createTestEntityManager();
    setupMocks(em, pkOnlyMetadata);
    mockQuery.mockResolvedValue({ results: { insertId: 1 }, fields: [] });

    await em.saveMany(PkOnly373, [{}, {}] as any);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!).replace(/\s+/g, " ");
    expect(insertSql).toContain("() VALUES (), ()");
    expect(insertSql).not.toContain("DEFAULT");
  });

  it("PostgreSQL: 모든 컬럼이 undefined인 batch는 PK + DEFAULT 행으로 RETURNING 해야 한다", async () => {
    const em = new EntityManager();
    (em as any).driver = {
      wrap: (name: string) => `"${name}"`,
      supportsExplain: () => false,
      supportsReturning: () => true,
    };
    (em as any).dbType = "postgres";
    setupMocks(em, pkOnlyMetadata);
    mockQuery.mockResolvedValue({
      results: [
        { id: 1, note: null },
        { id: 2, note: null },
      ],
      fields: [],
    });

    const results = await em.saveMany(PkOnly373, [{}, {}] as any);

    const insertCall = findInsertCall();
    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!).replace(/\s+/g, " ");
    expect(insertSql).toContain(`("id")`);
    expect(insertSql).toContain("VALUES (DEFAULT), (DEFAULT)");
    expect(insertSql).toContain("RETURNING");
    expect(insertSql).not.toContain("() VALUES");
    expect(results.length).toBe(2);
  });

  it("SQLite: 모든 컬럼이 undefined인 batch는 행마다 DEFAULT VALUES로 폴백하고 PK를 정확히 매핑해야 한다", async () => {
    const em = new EntityManager();
    (em as any).driver = {
      wrap: (name: string) => `"${name}"`,
      supportsExplain: () => false,
      supportsReturning: () => false,
      supportsInsertReturning: () => false,
    };
    (em as any).dbType = "sqlite";
    setupMocks(em, pkOnlyMetadata);

    let insertCount = 0;
    mockQuery.mockImplementation((q: any) => {
      const text = q?.text ?? q?.sql ?? String(q);
      if (text.includes("DEFAULT VALUES")) {
        insertCount += 1;
        // Per-row rowids 10, 11.
        return Promise.resolve({
          results: { lastInsertRowid: 9 + insertCount, changes: 1 },
        });
      }
      // Bulk SELECT WHERE id IN (10, 11)
      return Promise.resolve({
        results: [
          { id: 10, note: null },
          { id: 11, note: null },
        ],
        fields: [],
      });
    });

    const results = await em.saveMany(PkOnly373, [{}, {}] as any);

    const defaultInsertCalls = mockQuery.mock.calls.filter((call: any[]) =>
      getSqlText(call).includes("DEFAULT VALUES"),
    );
    expect(defaultInsertCalls.length).toBe(2);
    for (const call of defaultInsertCalls) {
      const text = getSqlText(call).replace(/\s+/g, " ");
      expect(text).toContain("DEFAULT VALUES");
      expect(text).not.toContain("() VALUES");
      expect(text).not.toContain("(DEFAULT)");
    }
    // PK assignment must come from the exact per-row rowids.
    expect(results.length).toBe(2);
    expect(results.map((r: any) => r.id).sort()).toEqual([10, 11]);
  });
});
