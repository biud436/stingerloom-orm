/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MySQL 8.0.19+ reads an upsert's proposed row through a row alias
 * (`INSERT … AS new`) instead of `VALUES()`, which 8.0.20 deprecated.
 * MariaDB never adopted the alias, and an unread version could be either
 * server, so both keep `VALUES()`.
 */
import "reflect-metadata";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { DbVersion } from "../../src/dialects/DbVersion";
import {
  mySqlProposedColumn,
  mySqlRowAlias,
  mySqlRowAliasClause,
} from "../../src/dialects/mysql/mySqlRowAlias";

const connector: any = { query: jest.fn() };

function driverFor(version?: string, clientType = "mysql"): MySqlDriver {
  return new MySqlDriver(
    connector,
    clientType,
    version === undefined ? undefined : DbVersion.parse(version),
  );
}

const wrap = (name: string) => `\`${name.split("`").join("``")}\``;

describe("MySqlDriver.supportsInsertRowAlias()", () => {
  it.each([
    ["8.0.18", false],
    ["8.0.19", true],
    ["8.4.13", true],
    ["9.1.0", true],
    ["5.7.44-log", false],
  ])("MySQL %s → %s", (version, expected) => {
    expect(driverFor(version).supportsInsertRowAlias()).toBe(expected);
  });

  it("is off for MariaDB, declared or detected behind type mysql", () => {
    expect(driverFor("10.11.6-MariaDB").supportsInsertRowAlias()).toBe(false);
    expect(driverFor("11.4.2", "mariadb").supportsInsertRowAlias()).toBe(false);
  });

  it("is off when the server version was never read", () => {
    // UNKNOWN switches every capability-table feature on, but the alias is
    // a syntax error on MariaDB and older MySQL, while VALUES() runs on all.
    expect(driverFor().supportsInsertRowAlias()).toBe(false);
    expect(driverFor("unknown").supportsInsertRowAlias()).toBe(false);
  });
});

describe("MySqlDriver.buildUpsertSql()", () => {
  const args: [string, string[], string[], string[]] = [
    "User",
    ["id", "email", "name"],
    ["id"],
    ["email", "name"],
  ];

  it("reads the proposed row through the alias on MySQL 8.0.19+", () => {
    expect(driverFor("8.0.36").buildUpsertSql(...args)).toBe(
      "INSERT INTO `User` (`id`, `email`, `name`) VALUES (?, ?, ?) " +
        "AS `new` (`__id`, `__email`, `__name`) " +
        "ON DUPLICATE KEY UPDATE `email` = `new`.`__email`, `name` = `new`.`__name`",
    );
  });

  it("keeps VALUES() on MariaDB", () => {
    expect(driverFor("10.11.6-MariaDB").buildUpsertSql(...args)).toBe(
      "INSERT INTO `User` (`id`, `email`, `name`) VALUES (?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE `email` = VALUES(`email`), `name` = VALUES(`name`)",
    );
  });

  it("does not collide with a table named new", () => {
    expect(
      driverFor("8.0.36").buildUpsertSql("new", ["id", "v"], ["id"], ["v"]),
    ).toBe(
      "INSERT INTO `new` (`id`, `v`) VALUES (?, ?) " +
        "AS `new_row` (`__id`, `__v`) " +
        "ON DUPLICATE KEY UPDATE `v` = `new_row`.`__v`",
    );
  });
});

describe("mySqlRowAlias helpers", () => {
  it("picks new unless the target, bare or qualified, is itself named new", () => {
    expect(mySqlRowAlias("`orders`", wrap)).toBe("`new`");
    expect(mySqlRowAlias("`renew`", wrap)).toBe("`new`");
    expect(mySqlRowAlias("`new`", wrap)).toBe("`new_row`");
    expect(mySqlRowAlias("`NEW`", wrap)).toBe("`new_row`");
    expect(mySqlRowAlias("`shop`.`New`", wrap)).toBe("`new_row`");
  });

  it("renames each column inside its quotes, keeping escapes", () => {
    expect(mySqlProposedColumn("`new`", "`records`")).toBe("`new`.`__records`");
    expect(mySqlProposedColumn("`new`", wrap("a`b"))).toBe("`new`.`__a``b`");
    expect(mySqlRowAliasClause("`new`", ["`a`", wrap("b`c")])).toBe(
      " AS `new` (`__a`, `__b``c`)",
    );
  });
});
