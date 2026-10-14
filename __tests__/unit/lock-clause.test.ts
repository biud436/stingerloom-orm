/**
 * Row-lock clause spelling per dialect. Shared locks with NOWAIT / SKIP
 * LOCKED differ between MySQL 8 (`FOR SHARE ...`; its `LOCK IN SHARE MODE`
 * takes no waiting option) and MariaDB (`LOCK IN SHARE MODE ...`; it has no
 * `FOR SHARE`). Real-server coverage: integration/sqb-dialect-suffix-dual.
 */
import { lockClause, lockDialectOf, type LockDialect } from "../../src/core/LockClause";
import { LockMode } from "../../src/dialects/FindOption";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { DbVersion } from "../../src/dialects/DbVersion";

describe("lockClause", () => {
  const table: Array<[LockMode, Record<Exclude<LockDialect, "sqlite">, string>]> = [
    [LockMode.PESSIMISTIC_WRITE, { postgres: "FOR UPDATE", mysql: "FOR UPDATE", mariadb: "FOR UPDATE" }],
    [
      LockMode.PESSIMISTIC_WRITE_NOWAIT,
      { postgres: "FOR UPDATE NOWAIT", mysql: "FOR UPDATE NOWAIT", mariadb: "FOR UPDATE NOWAIT" },
    ],
    [
      LockMode.PESSIMISTIC_WRITE_SKIP_LOCKED,
      {
        postgres: "FOR UPDATE SKIP LOCKED",
        mysql: "FOR UPDATE SKIP LOCKED",
        mariadb: "FOR UPDATE SKIP LOCKED",
      },
    ],
    [
      LockMode.PESSIMISTIC_READ,
      { postgres: "FOR SHARE", mysql: "LOCK IN SHARE MODE", mariadb: "LOCK IN SHARE MODE" },
    ],
    [
      LockMode.PESSIMISTIC_READ_NOWAIT,
      { postgres: "FOR SHARE NOWAIT", mysql: "FOR SHARE NOWAIT", mariadb: "LOCK IN SHARE MODE NOWAIT" },
    ],
    [
      LockMode.PESSIMISTIC_READ_SKIP_LOCKED,
      {
        postgres: "FOR SHARE SKIP LOCKED",
        mysql: "FOR SHARE SKIP LOCKED",
        mariadb: "LOCK IN SHARE MODE SKIP LOCKED",
      },
    ],
  ];

  it.each(table)("%s", (mode, expected) => {
    for (const dialect of ["postgres", "mysql", "mariadb"] as const) {
      expect(lockClause(mode, dialect)).toBe(expected[dialect]);
    }
  });
});

describe("lockDialectOf", () => {
  const ctx = (over: Partial<Parameters<typeof lockDialectOf>[0]>) => ({
    isMySqlFamily: () => false,
    isPostgres: () => false,
    ...over,
  });

  it("tells PostgreSQL, SQLite and MySQL apart", () => {
    expect(lockDialectOf(ctx({ isPostgres: () => true }))).toBe("postgres");
    expect(lockDialectOf(ctx({}))).toBe("sqlite");
    expect(lockDialectOf(ctx({ isMySqlFamily: () => true }))).toBe("mysql");
  });

  it("reads MariaDB from the declared type", () => {
    expect(lockDialectOf(ctx({ isMySqlFamily: () => true, getDbType: () => "mariadb" }))).toBe(
      "mariadb",
    );
  });

  it("reads MariaDB from the server version behind type: \"mysql\"", () => {
    const driver = new MySqlDriver(
      undefined as never,
      "mysql",
      DbVersion.parse("11.8.6-MariaDB-ubu2404"),
    );
    expect(driver.isMariaDb()).toBe(true);
    expect(
      lockDialectOf(ctx({ isMySqlFamily: () => true, getDbType: () => "mysql", getDriver: () => driver })),
    ).toBe("mariadb");
  });

  it("keeps a MySQL server on the MySQL spelling", () => {
    const driver = new MySqlDriver(undefined as never, "mysql", DbVersion.parse("8.4.11"));
    expect(driver.isMariaDb()).toBe(false);
    expect(lockDialectOf(ctx({ isMySqlFamily: () => true, getDriver: () => driver }))).toBe("mysql");
  });
});
