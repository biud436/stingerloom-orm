/**
 * Issue #372: nested-set/tree 쿼리 표현력 보강 검증.
 *
 * 1. JoinOnBuilder.onBetween / andOnBetween / onValBetween — 범위 포함 self-join
 * 2. addSelect((e) => ...) — dialect-portable 산술/집계 SELECT 표현식
 * 3. addSelectSubquery 팩토리 폼 — outer alias 참조 (상관 서브쿼리)
 * 4. delete/softDelete/restore criteria의 연산자 객체 (between/gt/lte/...)
 */
import "reflect-metadata";
import sql from "sql-template-tag";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  DeletedAt,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class TreeCategory372 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "int" })
  lft!: number;

  @Column({ type: "int" })
  rgt!: number;
}

@Entity()
class TreePost372 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  categoryId!: number;
}

function createMockEm(rows: any[] = []) {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
      getDialect: () => "mysql",
    },
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as EntityManager;
  return em;
}

describe("JoinOnBuilder.onBetween (#372)", () => {
  it("범위 포함 self-join ON 절을 생성해야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "node", em);
    qb.innerJoin(TreeCategory372, "parent", (j) =>
      j.onBetween("node.lft", "parent.lft", "parent.rgt"),
    );

    const { text } = qb.getSql();
    expect(text).toContain(
      "`node`.`lft` BETWEEN `parent`.`lft` AND `parent`.`rgt`",
    );
  });

  it("andOnBetween으로 추가 범위 조건을 AND 결합해야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "node", em);
    qb.innerJoin(TreeCategory372, "p", (j) =>
      j
        .on("node.id", "!=", "p.id")
        .andOnBetween("node.lft", "p.lft", "p.rgt"),
    );

    const { text } = qb.getSql();
    expect(text).toContain("`node`.`id` != `p`.`id`");
    expect(text).toContain("AND `node`.`lft` BETWEEN `p`.`lft` AND `p`.`rgt`");
  });

  it("onValBetween은 리터럴 값을 파라미터로 바인딩해야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "node", em);
    qb.innerJoin(TreeCategory372, "p", (j) => j.onValBetween("p.lft", 1, 42));

    const { text, values } = qb.getSql();
    expect(text).toContain("`p`.`lft` BETWEEN ? AND ?");
    expect(values).toEqual(expect.arrayContaining([1, 42]));
  });
});

describe("addSelect 표현식 빌더 (#372)", () => {
  it("집계 산술: COUNT(node.name) - 1 AS depth", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "node", em);
    qb.addSelect((e) => e.count("node.name").sub(1), "depth");

    const { text } = qb.getSql();
    expect(text).toContain("COUNT(`node`.`name`)");
    expect(text).toMatch(/COUNT\(`node`\.`name`\)\s*-\s*\?\s*\)?\s*AS `depth`/);
  });

  it("스칼라 산술: FLOOR((rgt - (lft + 1)) / 2) AS children", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "c", em);
    qb.addSelect(
      (e) => e.col("c.rgt").sub(e.col("c.lft").add(1)).div(2).floor(),
      "children",
    );

    const { text } = qb.getSql();
    expect(text).toContain("FLOOR(");
    expect(text).toContain("`c`.`rgt`");
    expect(text).toContain("`c`.`lft`");
    expect(text).toContain("AS `children`");
  });

  it("스칼라 표현식에 alias가 없으면 throw해야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "c", em);
    expect(() => qb.addSelect((e) => e.col("c.lft").add(1))).toThrow(
      /requires an alias/,
    );
  });

  it("AliasedExpression 반환 시 .as() alias를 사용해야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "c", em);
    qb.addSelect((e) => e.col("c.rgt").sub(e.col("c.lft")).as("width"));

    const { text } = qb.getSql();
    expect(text).toContain("AS `width`");
  });

  it("집계 표현식에 두 번째 인자 alias를 적용해야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "c", em);
    qb.addSelect((e) => e.count("*"), "total");

    const { text } = qb.getSql();
    expect(text).toContain("COUNT(*)");
    expect(text).toContain("AS `total`");
  });
});

describe("addSelectSubquery outer-alias 바인딩 (#372)", () => {
  it("팩토리 폼에서 outer 참조가 외부 alias의 escaped 식별자로 렌더링되어야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "node", em);

    qb.addSelectSubquery(
      (outer) =>
        new SelectQueryBuilder<TreePost372>(TreePost372, "p", em)
          .selectRaw(["COUNT(*)"])
          .innerJoin(TreeCategory372, "a", (j) =>
            j.on("p.categoryId", "=", "a.id"),
          )
          .where(
            sql`${outer("a.lft")} BETWEEN ${outer("node.lft")} AND ${outer("node.rgt")}`,
          ),
      "postCount",
    );

    const { text } = qb.getSql();
    expect(text).toContain("AS `postCount`");
    // 상관 조건: 외부 node alias가 서브쿼리 안에서 참조됨
    expect(text).toContain(
      "`a`.`lft` BETWEEN `node`.`lft` AND `node`.`rgt`",
    );
  });

  it("기존 pre-built 빌더 폼도 그대로 동작해야 한다", () => {
    const em = createMockEm();
    const sub = new SelectQueryBuilder<TreePost372>(TreePost372, "p", em).selectRaw([
      "COUNT(*)",
    ]);
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "node", em);
    qb.addSelectSubquery(sub, "cnt");

    const { text } = qb.getSql();
    expect(text).toContain("AS `cnt`");
  });

  it("whereExistsSubquery 팩토리 폼도 outer 참조를 지원해야 한다", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder<TreeCategory372>(TreeCategory372, "node", em);
    qb.whereExistsSubquery((outer) =>
      new SelectQueryBuilder<TreePost372>(TreePost372, "p", em)
        .selectRaw(["1"])
        .where(sql`${outer("node.id")} = ${1}`),
    );

    const { text } = qb.getSql();
    expect(text).toContain("EXISTS");
    expect(text).toContain("`node`.`id` = ?");
  });
});

// ── 쓰기 criteria 연산자 객체 ───────────────────────────────

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

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: mockQuery,
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

@Entity()
class WriteRange372 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  lft!: number;

  @Column({ type: "int" })
  rgt!: number;

  @DeletedAt()
  deletedAt!: Date | null;
}

const writeRangeMetadata = {
  name: "write_range372",
  target: WriteRange372,
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "lft", propertyKey: "lft", options: {} },
    { name: "rgt", propertyKey: "rgt", options: {} },
    { name: "deleted_at", propertyKey: "deletedAt", options: { nullable: true } },
  ],
};

function createWriteEm(withDeletedAt = false) {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };
  (em as any).dbType = "mysql";
  jest
    .spyOn((em as any).resolver, "resolveEntityMetadata")
    .mockImplementation((entity: any) =>
      entity === WriteRange372 ? writeRangeMetadata : null,
    );
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveManyToManyMetadata").mockReturnValue([]);
  jest
    .spyOn((em as any).resolver, "getDeletedAtColumn")
    .mockReturnValue(withDeletedAt ? "deleted_at" : null);
  return em;
}

function getSqlText(call: any[]): string {
  // `.sql` renders `?` placeholders; `.text` renders pg-style `$n`.
  return call[0].sql ?? call[0].text ?? String(call[0]);
}

describe("delete() criteria 연산자 객체 (#372)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ results: { affectedRows: 3 }, fields: [] });
  });

  it("between 연산자로 범위 삭제가 가능해야 한다 (서브트리 삭제)", async () => {
    const em = createWriteEm();
    const result = await em.delete(WriteRange372, {
      lft: { between: [5, 10] },
    } as any);

    const deleteCall = mockQuery.mock.calls.find((c: any[]) =>
      getSqlText(c).includes("DELETE"),
    );
    expect(deleteCall).toBeDefined();
    const text = getSqlText(deleteCall!);
    expect(text).toContain("`lft` BETWEEN ? AND ?");
    expect(deleteCall![0].values).toEqual(expect.arrayContaining([5, 10]));
    expect(result.affected).toBe(3);
  });

  it("gt/lte 연산자를 AND로 결합해야 한다", async () => {
    const em = createWriteEm();
    await em.delete(WriteRange372, { rgt: { gt: 7, lte: 99 } } as any);

    const deleteCall = mockQuery.mock.calls.find((c: any[]) =>
      getSqlText(c).includes("DELETE"),
    );
    const text = getSqlText(deleteCall!);
    expect(text).toContain("`rgt` > ?");
    expect(text).toContain("`rgt` <= ?");
  });

  it("기존 동작 보존: 배열은 IN, 스칼라는 =", async () => {
    const em = createWriteEm();
    await em.delete(WriteRange372, { id: [1, 2, 3] } as any);
    let call = mockQuery.mock.calls.find((c: any[]) =>
      getSqlText(c).includes("DELETE"),
    );
    expect(getSqlText(call!)).toContain("`id` IN");

    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ results: { affectedRows: 1 }, fields: [] });
    await em.delete(WriteRange372, { id: 1 } as any);
    call = mockQuery.mock.calls.find((c: any[]) =>
      getSqlText(c).includes("DELETE"),
    );
    expect(getSqlText(call!)).toContain("`id` = ?");
  });

  it("빈 criteria는 여전히 DeleteWithoutConditionsError를 던져야 한다", async () => {
    const em = createWriteEm();
    await expect(em.delete(WriteRange372, {} as any)).rejects.toThrow(
      /without.*condition|condition.*without|Delete/i,
    );
  });
});

describe("softDelete()/restore() criteria 연산자 객체 (#372)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ results: { affectedRows: 2 }, fields: [] });
  });

  it("softDelete에 between 연산자가 적용되어야 한다", async () => {
    const em = createWriteEm(true);
    await em.softDelete(WriteRange372, { lft: { between: [3, 8] } } as any);

    const updateCall = mockQuery.mock.calls.find((c: any[]) =>
      getSqlText(c).includes("UPDATE"),
    );
    expect(updateCall).toBeDefined();
    const text = getSqlText(updateCall!);
    expect(text).toContain("`lft` BETWEEN ? AND ?");
    expect(text).toContain("`deleted_at`");
  });

  it("restore에 gte 연산자가 적용되어야 한다", async () => {
    const em = createWriteEm(true);
    await em.restore(WriteRange372, { rgt: { gte: 10 } } as any);

    const updateCall = mockQuery.mock.calls.find((c: any[]) =>
      getSqlText(c).includes("UPDATE"),
    );
    expect(updateCall).toBeDefined();
    const text = getSqlText(updateCall!);
    expect(text).toContain("`rgt` >= ?");
    expect(text).toContain("= NULL");
  });
});
