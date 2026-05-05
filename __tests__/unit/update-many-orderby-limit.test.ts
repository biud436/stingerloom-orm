import "reflect-metadata";
import sql from "sql-template-tag";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { UpdateQueryBuilder } from "../../src/core/UpdateQueryBuilder";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

// ── Mocks ─────────────────────────────────────────────────

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

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  const mockQuery = jest.fn();
  const mockConnect = jest.fn().mockResolvedValue(undefined);
  const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
  const mockCommit = jest.fn().mockResolvedValue(undefined);
  const mockRollback = jest.fn().mockResolvedValue(undefined);
  const mockClose = jest.fn().mockResolvedValue(undefined);

  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
    __mockQuery: mockQuery,
  };
});

// ── Helpers ───────────────────────────────────────────────

function createTestEntityManager(dialect: "mysql" | "postgres" | "sqlite") {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) =>
      dialect === "postgres" || dialect === "sqlite"
        ? `"${name.replace(/"/g, '""')}"`
        : `\`${name.replace(/`/g, "``")}\``,
  };
  // _ctx.getDialect is read via the adapter
  (em as any)._ctx.getDialect = () => dialect;
  jest
    .spyOn(em as any, "isMySqlFamily")
    .mockReturnValue(dialect === "mysql");
  jest.spyOn(em as any, "isPostgres").mockReturnValue(dialect === "postgres");
  return em;
}

interface IssueShape {
  id: number;
  projectId: number;
  status: string;
  priority: number;
  number: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  deletedAt: Date | null;
}
class Issue {}

const issueMetadata = {
  name: "Issue",
  target: Issue,
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "project_id", propertyKey: "projectId", options: {} },
    { name: "status", propertyKey: "status", options: {} },
    { name: "priority", propertyKey: "priority", options: {} },
    { name: "number", propertyKey: "number", options: {} },
    { name: "claimedBy", propertyKey: "claimedBy", options: {} },
    { name: "claimedAt", propertyKey: "claimedAt", options: {} },
    { name: "deletedAt", propertyKey: "deletedAt", options: {} },
  ],
};

const composite = {
  name: "Composite",
  target: class Composite {},
  columns: [
    { name: "a", propertyKey: "a", options: { primary: true } },
    { name: "b", propertyKey: "b", options: { primary: true } },
    { name: "value", propertyKey: "value", options: {} },
  ],
};

const noPk = {
  name: "NoPk",
  target: class NoPk {},
  columns: [
    { name: "x", propertyKey: "x", options: {} },
    { name: "y", propertyKey: "y", options: {} },
  ],
};

function getLastUpdateSqlText(): string {
  const { __mockQuery } = jest.requireMock(
    "../../src/dialects/TransactionSessionManager",
  );
  const calls = __mockQuery.mock.calls;
  const updateCall = calls.find((call: any[]) => typeof call[0] !== "string");
  if (!updateCall) throw new Error("No UPDATE call captured");
  return updateCall[0].text ?? String(updateCall[0]);
}

// ── Tests ─────────────────────────────────────────────────

describe("updateMany — orderBy + limit", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
  });

  describe("MySQL family", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager("mysql");
      jest
        .spyOn((em as any).resolver, "resolveEntityMetadata")
        .mockReturnValue(issueMetadata);
      jest
        .spyOn((em as any).resolver, "getUpdateTimestampColumn")
        .mockReturnValue(null);
    });

    it("emits native UPDATE … ORDER BY … LIMIT n", async () => {
      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({
        results: { affectedRows: 1 },
        fields: [],
      });

      const result = await em.updateMany(
        issueMetadata.target,
        { claimedBy: "worker-1" } as any,
        {
          where: { projectId: 5 } as any,
          orderBy: { priority: "ASC", number: "ASC" },
          limit: 1,
        },
      );

      expect(result.affected).toBe(1);
      const text = getLastUpdateSqlText();
      expect(text).toMatch(/^UPDATE/);
      expect(text).toContain("SET");
      expect(text).toContain("WHERE");
      expect(text).toContain("ORDER BY");
      expect(text).toContain("`priority` ASC");
      expect(text).toContain("`number` ASC");
      expect(text).toContain("LIMIT 1");
      // No subquery rewrite on MySQL
      expect(text).not.toMatch(/IN \(SELECT/);
    });

    it("preserves existing behavior when orderBy/limit are omitted", async () => {
      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({
        results: { affectedRows: 3 },
        fields: [],
      });

      const result = await em.updateMany(
        issueMetadata.target,
        { claimedBy: "worker-1" } as any,
        { where: { projectId: 5 } as any },
      );

      expect(result.affected).toBe(3);
      const text = getLastUpdateSqlText();
      expect(text).toContain("UPDATE");
      expect(text).toContain("WHERE");
      expect(text).not.toContain("ORDER BY");
      expect(text).not.toContain("LIMIT");
    });

    it("sanitizes the ORDER BY direction (DESC normalized; no injection)", async () => {
      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({
        results: { affectedRows: 1 },
        fields: [],
      });

      await em.updateMany(
        issueMetadata.target,
        { claimedBy: "w" } as any,
        {
          where: { projectId: 5 } as any,
          orderBy: { priority: "DESC", number: "ASC" } as any,
          limit: 1,
        },
      );

      const text = getLastUpdateSqlText();
      expect(text).toContain("`priority` DESC");
      expect(text).toContain("`number` ASC");
      // Anything that is not the literal "DESC" must default to ASC; we
      // never emit caller-supplied strings as raw SQL.
      expect(text).not.toContain(";");
    });

    it("allows Sql expressions in SET alongside orderBy/limit", async () => {
      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({
        results: { affectedRows: 1 },
        fields: [],
      });

      await em.updateMany(
        issueMetadata.target,
        { claimedBy: "w", claimedAt: sql`NOW()` } as any,
        {
          where: { projectId: 5 } as any,
          orderBy: { priority: "ASC" },
          limit: 1,
        },
      );

      const text = getLastUpdateSqlText();
      expect(text).toContain("NOW()");
      expect(text).toContain("LIMIT 1");
    });
  });

  describe("PostgreSQL", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager("postgres");
      jest
        .spyOn((em as any).resolver, "resolveEntityMetadata")
        .mockReturnValue(issueMetadata);
      jest
        .spyOn((em as any).resolver, "getUpdateTimestampColumn")
        .mockReturnValue(null);
    });

    it("rewrites to UPDATE … WHERE pk IN (SELECT pk FROM … ORDER BY … LIMIT n)", async () => {
      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({
        rowCount: 1,
        results: undefined,
        fields: [],
      });

      const result = await em.updateMany(
        issueMetadata.target,
        { claimedBy: "worker-1" } as any,
        {
          where: { projectId: 5 } as any,
          orderBy: { priority: "ASC", number: "ASC" },
          limit: 1,
        },
      );

      expect(result.affected).toBe(1);
      const text = getLastUpdateSqlText();
      expect(text).toMatch(/^UPDATE/);
      // Subquery-based rewrite, keyed on the PK ("id")
      expect(text).toMatch(/WHERE\s+"id"\s+IN\s+\(SELECT\s+"id"\s+FROM/i);
      expect(text).toContain('ORDER BY "priority" ASC');
      expect(text).toContain('"number" ASC');
      expect(text).toContain("LIMIT 1");
    });

    it("preserves existing simple shape when orderBy/limit are omitted", async () => {
      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({
        rowCount: 3,
        results: undefined,
        fields: [],
      });

      const result = await em.updateMany(
        issueMetadata.target,
        { claimedBy: "w" } as any,
        { where: { projectId: 5 } as any },
      );

      expect(result.affected).toBe(3);
      const text = getLastUpdateSqlText();
      expect(text).not.toMatch(/IN \(SELECT/);
      expect(text).not.toContain("ORDER BY");
    });

    it("throws UNSUPPORTED_OPERATION on composite-PK + limit", async () => {
      jest
        .spyOn((em as any).resolver, "resolveEntityMetadata")
        .mockReturnValue(composite);

      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({ rowCount: 0, results: undefined, fields: [] });

      await expect(
        em.updateMany(
          composite.target,
          { value: 1 } as any,
          {
            where: { a: 1 } as any,
            orderBy: { value: "ASC" } as any,
            limit: 1,
          },
        ),
      ).rejects.toMatchObject({
        code: OrmErrorCode.UNSUPPORTED_OPERATION,
      });
    });

    it("throws PRIMARY_KEY_NOT_FOUND when no PK + limit on PG", async () => {
      jest
        .spyOn((em as any).resolver, "resolveEntityMetadata")
        .mockReturnValue(noPk);

      const { __mockQuery } = jest.requireMock(
        "../../src/dialects/TransactionSessionManager",
      );
      __mockQuery.mockResolvedValue({ rowCount: 0, results: undefined, fields: [] });

      await expect(
        em.updateMany(
          noPk.target,
          { y: 1 } as any,
          {
            where: { x: 1 } as any,
            orderBy: { y: "ASC" } as any,
            limit: 1,
          },
        ),
      ).rejects.toMatchObject({
        code: OrmErrorCode.PRIMARY_KEY_NOT_FOUND,
      });
    });
  });

  describe("validation", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager("mysql");
      jest
        .spyOn((em as any).resolver, "resolveEntityMetadata")
        .mockReturnValue(issueMetadata);
      jest
        .spyOn((em as any).resolver, "getUpdateTimestampColumn")
        .mockReturnValue(null);
    });

    it("rejects negative limit", async () => {
      await expect(
        em.updateMany(
          issueMetadata.target,
          { claimedBy: "w" } as any,
          {
            where: { projectId: 5 } as any,
            orderBy: { priority: "ASC" },
            limit: -1,
          },
        ),
      ).rejects.toBeInstanceOf(InvalidQueryError);
    });

    it("rejects non-integer limit", async () => {
      await expect(
        em.updateMany(
          issueMetadata.target,
          { claimedBy: "w" } as any,
          {
            where: { projectId: 5 } as any,
            orderBy: { priority: "ASC" },
            limit: 1.5 as any,
          },
        ),
      ).rejects.toBeInstanceOf(InvalidQueryError);
    });
  });
});

describe("UpdateQueryBuilder", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
  });

  it("execute() returns { affected } and emits SET/WHERE/ORDER BY/LIMIT on MySQL", async () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    __mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      fields: [],
    });

    const result = await em
      .createUpdateBuilder<IssueShape>(issueMetadata.target as any, "i")
      .set({ claimedBy: "worker-1" } as any)
      .where(sql`\`project_id\` = ${5}`)
      .andWhere(sql`\`status\` = ${"TODO"}`)
      .orderBy("priority", "ASC")
      .addOrderBy("number", "ASC")
      .limit(1)
      .execute();

    expect(result.affected).toBe(1);
    const text = getLastUpdateSqlText();
    expect(text).toContain("SET");
    expect(text).toContain("WHERE");
    expect(text).toContain("ORDER BY");
    expect(text).toContain("`priority` ASC");
    expect(text).toContain("LIMIT 1");
  });

  it("setRaw() inlines a Sql expression for one column", async () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    __mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      fields: [],
    });

    await em
      .createUpdateBuilder<IssueShape>(issueMetadata.target as any)
      .set({ claimedBy: "w" } as any)
      .setRaw("claimedAt", sql`NOW()`)
      .where(sql`\`id\` = ${1}`)
      .execute();

    const text = getLastUpdateSqlText();
    expect(text).toContain("NOW()");
    expect(text).toContain("`claimedBy`");
    expect(text).toContain("`claimedAt`");
  });

  it("toSql() returns deterministic text+values without executing", () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    const { text, values } = em
      .createUpdateBuilder<IssueShape>(issueMetadata.target as any, "i")
      .set({ claimedBy: "w" } as any)
      .where(sql`\`project_id\` = ${42}`)
      .orderBy("priority", "DESC")
      .limit(5)
      .toSql();

    expect(text).toContain("UPDATE");
    expect(text).toContain("`priority` DESC");
    expect(text).toContain("LIMIT 5");
    expect(values).toContain("w");
    expect(values).toContain(42);
  });

  it("throws when execute() runs without any .set() call", async () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);

    await expect(
      em
        .createUpdateBuilder(issueMetadata.target as any)
        .where(sql`\`id\` = ${1}`)
        .execute(),
    ).rejects.toBeInstanceOf(OrmError);
  });

  it("rejects non-integer/negative limit at the builder boundary", () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);

    const builder = em.createUpdateBuilder(issueMetadata.target as any);
    expect(() => builder.limit(-1)).toThrow(OrmError);
    expect(() => builder.limit(2.5)).toThrow(OrmError);
  });

  it("PostgreSQL: builder uses subquery rewrite when limit is set", async () => {
    const em = createTestEntityManager("postgres");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    __mockQuery.mockResolvedValue({ rowCount: 1, results: undefined, fields: [] });

    await em
      .createUpdateBuilder<IssueShape>(issueMetadata.target as any, "i")
      .set({ claimedBy: "w" } as any)
      .where(sql`"project_id" = ${5}`)
      .orderBy("priority", "ASC")
      .limit(1)
      .execute();

    const text = getLastUpdateSqlText();
    expect(text).toMatch(/WHERE\s+"id"\s+IN\s+\(SELECT\s+"id"\s+FROM/i);
    expect(text).toContain("LIMIT 1");
  });
});

describe("BaseRepository.createUpdateBuilder", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
  });

  it("returns an UpdateQueryBuilder bound to the repository's entity", () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);

    const repo = new BaseRepository<IssueShape>(
      issueMetadata.target as any,
      em,
    );
    const builder = repo.createUpdateBuilder("i");
    expect(builder).toBeInstanceOf(UpdateQueryBuilder);
  });

  it("accepts a qAlias EntityRef", () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);

    const repo = new BaseRepository<IssueShape>(
      issueMetadata.target as any,
      em,
    );
    const ref = {
      _alias: "i",
      _entity: issueMetadata.target,
      col: (c: string) => `i.${c}`,
    } as any;
    const builder = repo.createUpdateBuilder(ref);
    expect(builder).toBeInstanceOf(UpdateQueryBuilder);
  });

  it("end-to-end: repo.createUpdateBuilder().set(...).where(...).limit(...).execute()", async () => {
    const em = createTestEntityManager("mysql");
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(issueMetadata);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    __mockQuery.mockResolvedValue({
      results: { affectedRows: 2 },
      fields: [],
    });

    const repo = new BaseRepository<IssueShape>(
      issueMetadata.target as any,
      em,
    );

    const result = await repo
      .createUpdateBuilder("i")
      .set({ claimedBy: "worker-A" } as any)
      .where(sql`\`status\` = ${"TODO"}`)
      .orderBy("priority", "ASC")
      .limit(2)
      .execute();

    expect(result.affected).toBe(2);
    const text = getLastUpdateSqlText();
    expect(text).toContain("UPDATE");
    expect(text).toContain("`priority` ASC");
    expect(text).toContain("LIMIT 2");
  });
});
