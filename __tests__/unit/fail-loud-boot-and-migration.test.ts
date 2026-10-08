/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Boot and migration failures that used to be swallowed now surface:
 * an unknown column type, a glob-matched entity file that does not load,
 * an unreadable server version or a `versionOverride` that is not one, and
 * an advisory lock that failed for a reason other than another holder.
 */
import "reflect-metadata";
import * as path from "path";
import { ColumnTypeRegistry } from "../../src/core/ColumnTypeRegistry";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { resolveEntityGlobs } from "../../src/utils/resolveEntityGlobs";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { DbVersion, detectDbVersion } from "../../src/dialects/DbVersion";
import { validateDatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { IConnector } from "../../src/core/IConnector";

function errorOf(fn: () => unknown): any {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("unknown column types", () => {
  afterEach(() => {
    ColumnTypeRegistry.getInstance().clear();
  });

  it("throws with the closest built-in type instead of declaring the name as written", () => {
    const error = errorOf(() => new SqliteColumnDefinitionBuilder().castType("varchr"));
    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain('Unknown column type "varchr". Did you mean "varchar"?');
    expect(error?.message).toContain("ColumnTypeRegistry");
  });

  it("does not accept a built-in type in another case", () => {
    const error = errorOf(() => new PostgresColumnDefinitionBuilder().castType("VARCHAR"));
    expect(error?.message).toContain('Did you mean "varchar"?');
  });

  it("names no type when nothing is close", () => {
    const error = errorOf(() => new SqliteColumnDefinitionBuilder().castType("geography"));
    expect(error?.message).toMatch(/^Unknown column type "geography"\.\n/);
  });

  it("keeps a registered type, declared as written on a dialect it does not map", () => {
    ColumnTypeRegistry.getInstance().register("citext", { postgres: "CITEXT" });
    expect(new PostgresColumnDefinitionBuilder().castType("citext")).toBe("CITEXT");
    expect(new SqliteColumnDefinitionBuilder().castType("citext")).toBe("citext");
  });

  it("suggests a registered type", () => {
    ColumnTypeRegistry.getInstance().register("geometry", { postgres: "geometry" });
    const error = errorOf(() => new PostgresColumnDefinitionBuilder().castType("geomtry"));
    expect(error?.message).toContain('Did you mean "geometry"?');
  });
});

describe("entity glob files that fail to load", () => {
  const dir = path.join(__dirname, "fixtures", "glob-entities-broken");

  it("throws naming the file and its error instead of leaving its entities out", async () => {
    const error = await rejectionOf(() => resolveEntityGlobs([path.join(dir, "*.entity.ts")]));
    expect(error?.code).toBe(OrmErrorCode.ENTITY_GLOB_LOAD_FAILED);
    expect(error?.message).toContain(path.join(dir, "broken.entity.ts"));
    expect(error?.message).toContain("broken entity file");
    expect(error?.message).not.toContain("good.entity.ts");
  });

  it("still loads a pattern whose files all load", async () => {
    const entities = await resolveEntityGlobs([path.join(dir, "good.entity.ts")]);
    expect(entities.map((e) => e.name)).toEqual(["GlobGood"]);
  });
});

describe("server version detection", () => {
  it("warns with the cause when the version cannot be read", async () => {
    const warn = jest.fn();
    const version = await detectDbVersion(
      async () => {
        throw new Error("permission denied for function version");
      },
      warn,
      "PostgreSQL",
    );
    expect(version).toBe(DbVersion.UNKNOWN);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("permission denied for function version");
    expect(warn.mock.calls[0][0]).toContain("versionOverride");
  });

  it("warns when the reply does not read as a version", async () => {
    const warn = jest.fn();
    const version = await detectDbVersion(async () => "unavailable", warn, "MySQL");
    expect(version).toBe(DbVersion.UNKNOWN);
    expect(warn.mock.calls[0][0]).toContain('"unavailable"');
  });

  it("parses a readable version without warning", async () => {
    const warn = jest.fn();
    const version = await detectDbVersion(async () => "10.11.6-MariaDB", warn, "MySQL");
    expect(version.toString()).toBe("10.11.6");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a versionOverride that is not a version", () => {
    const options = { type: "sqlite", database: ":memory:", entities: [] } as any;
    const error = errorOf(() =>
      validateDatabaseClientOptions({ ...options, versionOverride: "latest" }),
    );
    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain("'versionOverride' must be a version");
    expect(errorOf(() => validateDatabaseClientOptions({ ...options, versionOverride: "3.45.0" }))).toBeNull();
  });
});

describe("PostgreSQL timed advisory lock", () => {
  function connectorWith(onLock: () => unknown, onRestore?: () => unknown) {
    const statements: string[] = [];
    const release = jest.fn();
    let sets = 0;
    const connector = {
      getVersion: () => undefined,
      getConnection: jest.fn().mockResolvedValue({ release }),
      query: jest.fn(async (q: any) => {
        const text = typeof q === "string" ? q : q?.text ?? q?.sql ?? "";
        statements.push(text);
        if (text.includes("SHOW")) return { results: [{ statement_timeout: "30s" }] };
        if (text.includes("pg_advisory_lock")) return onLock();
        if (text.includes("SET statement_timeout") && ++sets > 1 && onRestore) return onRestore();
        return { results: [] };
      }),
    } as unknown as IConnector;
    return { connector, statements, release };
  }

  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  it("returns false only when the statement timeout elapsed", async () => {
    const { connector, release } = connectorWith(() => {
      throw pgError("57014", "canceling statement due to statement timeout");
    });
    await expect(new PostgresDriver(connector).acquireAdvisoryLock("lock", 100)).resolves.toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other failure instead of reporting a held lock", async () => {
    const { connector, release } = connectorWith(() => {
      throw pgError("57P01", "terminating connection due to administrator command");
    });
    const error = await rejectionOf(() => new PostgresDriver(connector).acquireAdvisoryLock("lock", 100));
    expect(error?.code).toBe("57P01");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the lock error when restoring the timeout also fails", async () => {
    const { connector } = connectorWith(
      () => {
        throw pgError("57P01", "terminating connection due to administrator command");
      },
      () => {
        throw new Error("Connection terminated");
      },
    );
    const error = await rejectionOf(() => new PostgresDriver(connector).acquireAdvisoryLock("lock", 100));
    expect(error?.code).toBe("57P01");
  });

  it("restores the client's own statement timeout", async () => {
    const { connector, statements } = connectorWith(() => ({ results: [] }));
    await expect(new PostgresDriver(connector).acquireAdvisoryLock("lock", 100)).resolves.toBe(true);
    expect(statements.filter((s) => s.startsWith("SET statement_timeout"))).toEqual([
      "SET statement_timeout = '100ms'",
      "SET statement_timeout = '30s'",
    ]);
  });
});

describe("MySQL advisory lock", () => {
  const driverReturning = (lockResult: unknown) =>
    new MySqlDriver({
      getVersion: () => undefined,
      query: jest.fn(async () => [{ lock_result: lockResult }]),
    } as unknown as IConnector);

  it("treats GET_LOCK's 0 as a timeout and NULL as an error", async () => {
    await expect(driverReturning(1).acquireAdvisoryLock("lock", 1000)).resolves.toBe(true);
    await expect(driverReturning(0).acquireAdvisoryLock("lock", 1000)).resolves.toBe(false);
    const error = await rejectionOf(() => driverReturning(null).acquireAdvisoryLock("lock", 1000));
    expect(error?.code).toBe(OrmErrorCode.ADVISORY_LOCK_FAILED);
    expect(error?.message).toContain("returned NULL");
  });
});
