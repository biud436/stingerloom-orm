import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToMany,
} from "../../src/decorators";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

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

const mockQuery = jest
  .fn()
  .mockResolvedValue({ results: { affectedRows: 1 }, fields: {} });
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

@Entity()
class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 64 })
  name!: string;
}

@Entity()
class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 255 })
  title!: string;

  @ManyToMany(() => Tag, {
    joinTable: {
      name: "article_tags",
      joinColumn: "article_id",
      inverseJoinColumn: "tag_id",
    },
  })
  tags!: Tag[];
}

@Entity()
class TagInverse {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToMany(() => Article, { mappedBy: "tags" })
  articles!: Article[];
}

function makeEm(driverKind: "mysql" | "postgres"): EntityManager {
  const em = new EntityManager();
  const isMysql = driverKind === "mysql";
  (em as any).driver = {
    wrap: (n: string) =>
      isMysql ? `\`${n.replace(/`/g, "``")}\`` : `"${n.replace(/"/g, '""')}"`,
    isMySqlFamily: () => isMysql,
  };
  // Mark connected so executeInTransaction doesn't bail.
  (em as any).dbType = driverKind;
  return em;
}

describe("EntityManager.attachRelation / detachRelation", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      rowCount: 1,
      fields: {},
    });
  });

  it("MySQL emits INSERT IGNORE on attachRelation by default", async () => {
    const em = makeEm("mysql");
    const r = await em.attachRelation(Article, 7, "tags", 42);
    expect(r.affected).toBe(1);

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : (c[0]?.text ?? String(c[0])),
    );
    const insert = calls.find((s) => s.includes("INSERT IGNORE INTO"));
    expect(insert).toBeDefined();
    expect(insert).toContain("article_tags");
    expect(insert).toContain("article_id");
    expect(insert).toContain("tag_id");
  });

  it("PostgreSQL emits ON CONFLICT DO NOTHING on attachRelation by default", async () => {
    const em = makeEm("postgres");
    await em.attachRelation(Article, 7, "tags", 42);

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : (c[0]?.text ?? String(c[0])),
    );
    const insert = calls.find((s) => s.includes("ON CONFLICT DO NOTHING"));
    expect(insert).toBeDefined();
    expect(insert).toContain('"article_tags"');
  });

  it("attachRelation with ignoreExisting:false emits a plain INSERT", async () => {
    const em = makeEm("postgres");
    await em.attachRelation(Article, 1, "tags", 2, { ignoreExisting: false });

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : (c[0]?.text ?? String(c[0])),
    );
    const insert = calls.find((s) => s.includes("INSERT INTO"));
    expect(insert).toBeDefined();
    expect(insert).not.toContain("ON CONFLICT");
  });

  it("detachRelation emits a parameterized DELETE", async () => {
    const em = makeEm("mysql");
    await em.detachRelation(Article, 7, "tags", 42);

    const callArgs = mockQuery.mock.calls;
    const deleteCall = callArgs.find((c) => {
      const text = typeof c[0] === "string" ? c[0] : (c[0]?.text ?? "");
      return text.includes("DELETE FROM");
    });
    expect(deleteCall).toBeDefined();
    const text = deleteCall![0]?.text;
    expect(text).toContain("`article_tags`");
    expect(text).toContain("`article_id`");
    expect(text).toContain("`tag_id`");
    // Should bind ownerId and relatedId via parameters, not literals.
    expect(deleteCall![0]?.values).toEqual(expect.arrayContaining([7, 42]));
  });

  it("inverse-side mappedBy traverses to the owning side join table", async () => {
    const em = makeEm("postgres");
    await em.attachRelation(TagInverse, 5, "articles", 99);

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : (c[0]?.text ?? String(c[0])),
    );
    const insert = calls.find((s) => s.includes("INSERT INTO"));
    expect(insert).toBeDefined();
    expect(insert).toContain('"article_tags"');
    // From the inverse side, `ownerColumn` is the inverseJoinColumn (`tag_id`),
    // and `relatedColumn` is the joinColumn (`article_id`).
    const orderTagFirst = insert!.indexOf("tag_id") < insert!.indexOf("article_id");
    expect(orderTagFirst).toBe(true);
  });

  it("throws when called on a non-M2M property", async () => {
    const em = makeEm("postgres");
    await expect(
      em.attachRelation(Article, 1, "title" as any, 2),
    ).rejects.toThrow(/not a @ManyToMany/);
  });
});

describe("EntityManager.insertIgnore", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({
      results: { affectedRows: 0 },
      rowCount: 0,
      fields: {},
    });
  });

  it("MySQL emits INSERT IGNORE", async () => {
    const em = makeEm("mysql");
    const result = await em.insertIgnore(Tag, { id: 1, name: "alpha" });
    expect(result.affected).toBe(0);

    const callArgs = mockQuery.mock.calls;
    const insertCall = callArgs.find((c) => {
      const text = typeof c[0] === "string" ? c[0] : (c[0]?.text ?? "");
      return text.includes("INSERT IGNORE");
    });
    expect(insertCall).toBeDefined();
    expect(insertCall![0]?.values).toEqual(expect.arrayContaining([1, "alpha"]));
  });

  it("PostgreSQL emits INSERT … ON CONFLICT (pk) DO NOTHING", async () => {
    const em = makeEm("postgres");
    await em.insertIgnore(Tag, { id: 1, name: "beta" });

    const insertCall = mockQuery.mock.calls.find((c) => {
      const text = typeof c[0] === "string" ? c[0] : (c[0]?.text ?? "");
      return text.includes("ON CONFLICT");
    });
    expect(insertCall).toBeDefined();
    const text = insertCall![0]?.text;
    expect(text).toContain("DO NOTHING");
    expect(text).toContain('"id"');
  });
});
