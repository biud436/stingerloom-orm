import "reflect-metadata";
import {
  DatabaseClientOptions,
  ServerDatabaseClientOptions,
  validateDatabaseClientOptions,
} from "../../src/core/DatabaseClientOptions";
import { Logger } from "../../src/utils/Logger";

describe("validateDatabaseClientOptions - database field", () => {
  const serverBase: ServerDatabaseClientOptions = {
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "user",
    password: "pass",
    database: "testdb",
    entities: [],
  };

  it("should accept a non-empty database name", () => {
    expect(() => validateDatabaseClientOptions(serverBase)).not.toThrow();
  });

  it("should reject a missing database (undefined) as required", () => {
    const options = { ...serverBase } as Partial<ServerDatabaseClientOptions>;
    delete options.database;
    expect(() =>
      validateDatabaseClientOptions(options as DatabaseClientOptions),
    ).toThrow(/'database' is required/);
  });

  it.each(["postgres", "mysql", "mariadb"] as const)(
    "should reject an empty-string database for %s",
    (type) => {
      const port = type === "postgres" ? 5432 : 3306;
      expect(() =>
        validateDatabaseClientOptions({
          ...serverBase,
          type,
          port,
          database: "",
        }),
      ).toThrow(/'database' must not be empty/);
    },
  );

  it("should not raise a duplicate error when database is undefined (required only)", () => {
    const options = { ...serverBase } as Partial<ServerDatabaseClientOptions>;
    delete options.database;
    try {
      validateDatabaseClientOptions(options as DatabaseClientOptions);
      fail("expected validation to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("'database' is required");
      expect(message).not.toContain("must not be empty");
    }
  });

  it("should still allow an empty-string database for sqlite (anonymous temp db)", () => {
    const options: DatabaseClientOptions = {
      type: "sqlite",
      database: "",
      entities: [],
    };
    expect(() => validateDatabaseClientOptions(options)).not.toThrow();
  });

  it("should allow :memory: database for sqlite", () => {
    const options: DatabaseClientOptions = {
      type: "sqlite",
      database: ":memory:",
      entities: [],
    };
    expect(() => validateDatabaseClientOptions(options)).not.toThrow();
  });
});

describe("validateDatabaseClientOptions - unknown top-level keys", () => {
  const sqliteBase: DatabaseClientOptions = {
    type: "sqlite",
    database: ":memory:",
    entities: [],
  };

  let logs: string[];

  beforeEach(() => {
    logs = [];
    Logger.setOutput((msg) => logs.push(msg));
  });

  afterEach(() => {
    Logger.reset();
  });

  it("should warn about an unknown key with a closest-match suggestion", () => {
    const options = { ...sqliteBase, synchronise: true } as DatabaseClientOptions;
    expect(() => validateDatabaseClientOptions(options)).not.toThrow();
    const warning = logs.find((l) => l.includes("Unknown option 'synchronise'"));
    expect(warning).toBeDefined();
    expect(warning).toContain("Did you mean 'synchronize'?");
  });

  it("should warn without a suggestion when nothing is close", () => {
    const options = { ...sqliteBase, totallyBogus: 1 } as DatabaseClientOptions;
    validateDatabaseClientOptions(options);
    const warning = logs.find((l) => l.includes("Unknown option 'totallyBogus'"));
    expect(warning).toBeDefined();
    expect(warning).not.toContain("Did you mean");
  });

  it("should not warn when every key is known", () => {
    validateDatabaseClientOptions({ ...sqliteBase, synchronize: true });
    expect(logs.filter((l) => l.includes("Unknown option"))).toHaveLength(0);
  });

  it("should include the connection name in unknown-key warnings", () => {
    const options = { ...sqliteBase, sychronize: true } as DatabaseClientOptions;
    validateDatabaseClientOptions(options, "analytics");
    const warning = logs.find((l) => l.includes("Unknown option 'sychronize'"));
    expect(warning).toContain('(connection "analytics")');
  });
});

describe("validateDatabaseClientOptions - connectionName in errors", () => {
  it("should name the failing connection in the validation error", () => {
    const options = { type: "sqlite", entities: [] } as unknown as DatabaseClientOptions;
    expect(() => validateDatabaseClientOptions(options, "analytics")).toThrow(
      /Invalid database configuration \(connection "analytics"\)/,
    );
  });

  it("should keep the plain header when no connection name is given", () => {
    const options = { type: "sqlite", entities: [] } as unknown as DatabaseClientOptions;
    expect(() => validateDatabaseClientOptions(options)).toThrow(
      /Invalid database configuration:/,
    );
  });
});
