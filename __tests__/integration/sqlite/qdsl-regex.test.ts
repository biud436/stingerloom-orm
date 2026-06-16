/**
 * SQLite in-memory integration test for `.matches()` regex predicates.
 *
 * Validates the end-to-end path that golden/unit tests cannot: that the
 * `regexp` UDF registered by SqliteConnector actually backs the `REGEXP`
 * operator emitted by `ColumnExpression.matches()`, including inline-flag
 * patterns produced from JS RegExp flags.
 *
 * Runs against better-sqlite3 in-memory, so no external server is needed.
 */

import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  qAlias,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { generateTableName } from "../helpers/create-test-entity";
import { DatabaseClient } from "../../../src/DatabaseClient";
import sqlTag, { raw as sqlRaw } from "sql-template-tag";

describe("[Integration] SQLite In-Memory: regex (.matches) QueryDSL", () => {
  let conn: TestConnectionResult;
  let tableName: string;
  let EntityClass: new () => any;

  beforeAll(async () => {
    tableName = generateTableName("regex_dsl");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        const DynClass = class {} as any;
        Object.defineProperty(DynClass, "name", {
          value: tableName,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
        PrimaryGeneratedColumn()(DynClass.prototype, "id");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "label");
        Column()(DynClass.prototype, "label");

        Entity()(DynClass);
        EntityClass = DynClass;
        return { entities: [DynClass] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    const table = sqlRaw(`"${tableName}"`);
    const labels = ["apple", "Apple", "banana", "cherry123", "admin@x.com"];
    for (const label of labels) {
      await connector.query(
        sqlTag`INSERT INTO ${table} ("label") VALUES (${label})`,
      );
    }
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("matches a case-sensitive string pattern", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.label.matches("^a"))
      .getRawMany();
    // Only lowercase "apple" and "admin@x.com" start with a lowercase "a".
    expect(rows.map((r: any) => r.label).sort()).toEqual([
      "admin@x.com",
      "apple",
    ]);
  });

  it("matches case-insensitively via a RegExp i flag", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.label.matches(/^apple$/i))
      .getRawMany();
    expect(rows.map((r: any) => r.label).sort()).toEqual(["Apple", "apple"]);
  });

  it("matches a digit class", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.label.matches("[0-9]+"))
      .getRawMany();
    expect(rows.map((r: any) => r.label)).toEqual(["cherry123"]);
  });

  it("negates with .not()", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.label.matches(/^a/i).not())
      .getRawMany();
    // Excludes apple / Apple / admin@x.com (all start with a/A).
    expect(rows.map((r: any) => r.label).sort()).toEqual([
      "banana",
      "cherry123",
    ]);
  });

  it("anchors an email-shaped pattern", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.label.matches("^[^@]+@[^@]+\\.[a-z]+$"))
      .getRawMany();
    expect(rows.map((r: any) => r.label)).toEqual(["admin@x.com"]);
  });
});
