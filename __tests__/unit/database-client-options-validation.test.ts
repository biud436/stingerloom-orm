import "reflect-metadata";
import {
  DatabaseClientOptions,
  ServerDatabaseClientOptions,
  validateDatabaseClientOptions,
} from "../../src/core/DatabaseClientOptions";

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
