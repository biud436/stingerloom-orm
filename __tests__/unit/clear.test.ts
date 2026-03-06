import "reflect-metadata";
import Container from "typedi";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { BaseRepository } from "../../src/core/BaseRepository";

// Mock 모듈 설정
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
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

class User {
  id!: number;
  name!: string;
}

const userMetadata = {
  name: "User",
  target: User,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

describe("EntityManager.clear()", () => {
  let em: EntityManager;
  let mockClear: jest.Mock;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    jest.clearAllMocks();

    em = new EntityManager();
    mockClear = jest.fn().mockResolvedValue(undefined);
    (em as any).driver = {
      wrap: (name: string) => `\`${name}\``,
      clear: mockClear,
    };
  });

  it("should call driver.clear() with the table name", async () => {
    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);

    await em.clear(User);

    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockClear).toHaveBeenCalledWith("User");
  });

  it("should throw EntityMetadataNotFoundError if metadata is not found", async () => {
    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(null);

    await expect(em.clear(User)).rejects.toThrow();
  });

  it("should throw if driver is not initialized", async () => {
    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    (em as any).driver = undefined;

    await expect(em.clear(User)).rejects.toThrow(
      "Driver is not initialized",
    );
  });

  it("should propagate driver errors", async () => {
    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    mockClear.mockRejectedValue(new Error("TRUNCATE failed"));

    await expect(em.clear(User)).rejects.toThrow("TRUNCATE failed");
  });
});

describe("BaseRepository.clear()", () => {
  it("should delegate to EntityManager.clear()", async () => {
    const em = new EntityManager();
    const mockClear = jest.fn().mockResolvedValue(undefined);
    em.clear = mockClear;

    const repo = new BaseRepository(User, em);
    await repo.clear();

    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockClear).toHaveBeenCalledWith(User);
  });
});

describe("Driver.clear() SQL generation", () => {
  it("MySQL: should generate TRUNCATE TABLE with backtick-wrapped name", () => {
    const { MySqlDriver } = jest.requireActual(
      "../../src/dialects/mysql/MySqlDriver",
    );
    const mockConnector = { query: jest.fn().mockResolvedValue(undefined) };
    const driver = new MySqlDriver(mockConnector);

    driver.clear("cats");

    expect(mockConnector.query).toHaveBeenCalledWith("TRUNCATE TABLE `cats`");
  });

  it("MySQL: should escape special characters in table name", () => {
    const { MySqlDriver } = jest.requireActual(
      "../../src/dialects/mysql/MySqlDriver",
    );
    const mockConnector = { query: jest.fn().mockResolvedValue(undefined) };
    const driver = new MySqlDriver(mockConnector);

    driver.clear("my`table");

    expect(mockConnector.query).toHaveBeenCalledWith(
      "TRUNCATE TABLE `my``table`",
    );
  });

  it("PostgreSQL: should generate TRUNCATE with schema-qualified name and CASCADE", () => {
    const { PostgresDriver } = jest.requireActual(
      "../../src/dialects/postgres/PostgresDriver",
    );
    const mockConnector = { query: jest.fn().mockResolvedValue(undefined) };
    const driver = new PostgresDriver(mockConnector, "postgres", "public");

    driver.clear("cats");

    expect(mockConnector.query).toHaveBeenCalledWith(
      'TRUNCATE TABLE "public"."cats" RESTART IDENTITY CASCADE',
    );
  });

  it("PostgreSQL: should use custom schema", () => {
    const { PostgresDriver } = jest.requireActual(
      "../../src/dialects/postgres/PostgresDriver",
    );
    const mockConnector = { query: jest.fn().mockResolvedValue(undefined) };
    const driver = new PostgresDriver(mockConnector, "postgres", "tenant_1");

    driver.clear("users");

    expect(mockConnector.query).toHaveBeenCalledWith(
      'TRUNCATE TABLE "tenant_1"."users" RESTART IDENTITY CASCADE',
    );
  });

  it("SQLite: should generate DELETE FROM (no TRUNCATE support)", () => {
    const { SqliteDriver } = jest.requireActual(
      "../../src/dialects/sqlite/SqliteDriver",
    );
    const mockConnector = { query: jest.fn().mockResolvedValue(undefined) };
    const driver = new SqliteDriver(mockConnector);

    driver.clear("cats");

    expect(mockConnector.query).toHaveBeenCalledWith('DELETE FROM "cats"');
  });

});
