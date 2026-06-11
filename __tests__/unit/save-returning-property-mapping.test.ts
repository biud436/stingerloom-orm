/**
 * Issue #369: RETURNING * 행을 그대로 역직렬화하지 않고 ResultTransformer를
 * 거쳐 DB 컬럼명 → 엔티티 프로퍼티 키 매핑을 적용하는지 검증합니다.
 *
 * - INSERT ... RETURNING (MariaDB 10.5+/PostgreSQL) 결과의 키가
 *   @Column({ name }) 프로퍼티 키로 매핑되어야 한다
 * - UPDATE ... RETURNING 경로도 동일
 * - 컬럼 transformer.from도 적용되어야 한다
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

@Entity({ name: "category369" })
class Category369 {
  @PrimaryGeneratedColumn({ name: "CTGR_SQ" })
  id!: number;

  @Column({ type: "varchar", name: "CTGR_NM" })
  name!: string;

  @Column({ type: "int", name: "LFT_NO" })
  left!: number;

  @Column({ type: "int", name: "RGT_NO" })
  right!: number;

  @Column({ type: "int", name: "CTGR_GRP_SQ" })
  groupId!: number;
}

const categoryMetadata = {
  name: "category369",
  target: Category369,
  columns: [
    {
      name: "CTGR_SQ",
      propertyKey: "id",
      options: { primary: true, autoIncrement: true },
    },
    { name: "CTGR_NM", propertyKey: "name", options: {} },
    { name: "LFT_NO", propertyKey: "left", options: {} },
    { name: "RGT_NO", propertyKey: "right", options: {} },
    { name: "CTGR_GRP_SQ", propertyKey: "groupId", options: {} },
  ],
};

function createReturningEntityManager() {
  const em = new EntityManager();
  // MariaDB 10.5+ 스타일: MySQL family + RETURNING 지원
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
    supportsReturning: () => true,
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

describe("save() INSERT RETURNING — 컬럼명 → 프로퍼티 키 매핑 (#369)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createReturningEntityManager();
    setupMocks(em);
  });

  it("RETURNING 행의 DB 컬럼 키가 엔티티 프로퍼티 키로 매핑되어야 한다", async () => {
    mockQuery.mockResolvedValue({
      results: [
        { CTGR_SQ: 1, CTGR_NM: "root", LFT_NO: 1, RGT_NO: 2, CTGR_GRP_SQ: 1 },
      ],
      fields: [],
    });

    const saved = await em.save(Category369, {
      name: "root",
      left: 1,
      right: 2,
      groupId: 1,
    } as any);

    expect(saved).toBeInstanceOf(Category369);
    expect(saved.id).toBe(1);
    expect(saved.name).toBe("root");
    expect(saved.left).toBe(1);
    expect(saved.right).toBe(2);
    expect(saved.groupId).toBe(1);
    // 원시 DB 키가 그대로 노출되면 안 됨
    expect((saved as any).CTGR_SQ).toBeUndefined();
    expect((saved as any).LFT_NO).toBeUndefined();
  });

  it("save() 반환값을 다시 save()해도 FK/컬럼이 유실되지 않아야 한다 (round-trip)", async () => {
    mockQuery.mockResolvedValue({
      results: [
        { CTGR_SQ: 1, CTGR_NM: "root", LFT_NO: 1, RGT_NO: 2, CTGR_GRP_SQ: 1 },
      ],
      fields: [],
    });

    const saved = await em.save(Category369, {
      name: "root",
      left: 1,
      right: 2,
      groupId: 1,
    } as any);

    // round-trip: 반환된 엔티티를 수정 후 재저장 (UPDATE 경로)
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({
      results: [
        { CTGR_SQ: 1, CTGR_NM: "renamed", LFT_NO: 1, RGT_NO: 2, CTGR_GRP_SQ: 1 },
      ],
      fields: [],
      rowCount: 1,
    });
    saved.name = "renamed";
    await em.save(Category369, saved);

    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = call[0].text ?? call[0].sql ?? String(call[0]);
      return text.includes("UPDATE");
    });
    expect(updateCall).toBeDefined();
    const updateSql = updateCall![0].text ?? updateCall![0].sql;
    // 프로퍼티 키가 살아 있으므로 모든 컬럼 값이 SET에 포함된다
    expect(updateSql).toContain("`CTGR_NM`");
    expect(updateSql).toContain("`LFT_NO`");
    // NULL 덮어쓰기가 발생하면 안 됨
    expect(updateCall![0].values).not.toContain(null);
  });

  it("UPDATE ... RETURNING 반환값도 프로퍼티 키로 매핑되어야 한다", async () => {
    mockQuery.mockResolvedValue({
      results: [
        { CTGR_SQ: 5, CTGR_NM: "updated", LFT_NO: 3, RGT_NO: 4, CTGR_GRP_SQ: 2 },
      ],
      fields: [],
      rowCount: 1,
    });

    const saved = await em.save(Category369, {
      id: 5,
      name: "updated",
      left: 3,
      right: 4,
      groupId: 2,
    } as any);

    expect(saved).toBeInstanceOf(Category369);
    expect(saved.id).toBe(5);
    expect(saved.name).toBe("updated");
    expect(saved.left).toBe(3);
    expect(saved.right).toBe(4);
    expect((saved as any).CTGR_NM).toBeUndefined();
  });
});

describe("save() INSERT RETURNING — 컬럼 transformer 적용 (#369)", () => {
  @Entity({ name: "transformed369" })
  class Transformed369 {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({
      type: "varchar",
      name: "tags_csv",
      transformer: {
        to: (value: string[]) => (value ? value.join(",") : value),
        from: (value: string) => (value ? value.split(",") : []),
      },
    })
    tags!: string[];
  }

  const transformedMetadata = {
    name: "transformed369",
    target: Transformed369,
    columns: [
      {
        name: "id",
        propertyKey: "id",
        options: { primary: true, autoIncrement: true },
      },
      {
        name: "tags_csv",
        propertyKey: "tags",
        options: {},
        transformer: {
          to: (value: string[]) => (value ? value.join(",") : value),
          from: (value: string) => (value ? value.split(",") : []),
        },
      },
    ],
  };

  it("RETURNING 행에 transformer.from이 적용되어야 한다", async () => {
    jest.clearAllMocks();
    const em = createReturningEntityManager();
    setupMocks(em, transformedMetadata);
    mockQuery.mockResolvedValue({
      results: [{ id: 1, tags_csv: "a,b,c" }],
      fields: [],
    });

    const saved = await em.save(Transformed369, { tags: ["a", "b", "c"] } as any);

    expect(saved.id).toBe(1);
    expect(saved.tags).toEqual(["a", "b", "c"]);
    expect((saved as any).tags_csv).toBeUndefined();
  });
});

describe("saveMany() batch INSERT RETURNING — 매핑 (#369)", () => {
  it("batch RETURNING 결과도 프로퍼티 키로 매핑되어야 한다", async () => {
    jest.clearAllMocks();
    const em = createReturningEntityManager();
    setupMocks(em);
    mockQuery.mockResolvedValue({
      results: [
        { CTGR_SQ: 1, CTGR_NM: "a", LFT_NO: 1, RGT_NO: 2, CTGR_GRP_SQ: 1 },
        { CTGR_SQ: 2, CTGR_NM: "b", LFT_NO: 3, RGT_NO: 4, CTGR_GRP_SQ: 1 },
      ],
      fields: [],
    });

    const saved = await em.saveMany(Category369, [
      { name: "a", left: 1, right: 2, groupId: 1 } as any,
      { name: "b", left: 3, right: 4, groupId: 1 } as any,
    ]);

    expect(saved).toHaveLength(2);
    expect(saved[0].id).toBe(1);
    expect(saved[0].name).toBe("a");
    expect(saved[1].id).toBe(2);
    expect(saved[1].left).toBe(3);
    expect((saved[0] as any).CTGR_SQ).toBeUndefined();
  });
});
