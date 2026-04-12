/**
 * SQLite in-memory integration test for JSON path QueryDSL.
 *
 * Verifies that `qAlias()` plus the new `JsonPathExpression`/`DialectExpression`
 * machinery emits correct `json_extract` / `json_array_length` / `json_type`
 * SQL and returns the expected rows end-to-end on a real driver.
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

describe("[Integration] SQLite In-Memory: JSON path QueryDSL", () => {
  let conn: TestConnectionResult;
  let tableName: string;
  let EntityClass: new () => any;

  beforeAll(async () => {
    tableName = generateTableName("json_dsl");

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

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
        Column()(DynClass.prototype, "name");

        // `profile` JSON column — SQLite maps this to TEXT and we store JSON strings.
        Reflect.defineMetadata("design:type", Object, DynClass.prototype, "profile");
        Column({ type: "json", nullable: true })(DynClass.prototype, "profile");

        Entity()(DynClass);
        EntityClass = DynClass;
        return { entities: [DynClass] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();

    // Seed rows with JSON payloads. We insert JSON via raw connector so that
    // SQLite stores text we can later navigate with json_extract().
    const rows = [
      {
        name: "alice",
        profile: JSON.stringify({
          contact: { email: "alice@example.com" },
          personal: { age: 30, city: "Seoul" },
          role: "admin",
          tags: ["red", "blue", "green"],
        }),
      },
      {
        name: "bob",
        profile: JSON.stringify({
          contact: { email: "bob@example.com" },
          personal: { age: 22, city: "Seoul" },
          role: "editor",
          tags: ["red"],
        }),
      },
      {
        name: "carol",
        profile: JSON.stringify({
          contact: { email: "carol@example.com" },
          personal: { age: 45, city: "Busan" },
          role: "viewer",
          tags: [],
        }),
      },
      {
        name: "dave",
        profile: JSON.stringify({ role: "viewer" }),
      },
    ];
    const table = sqlRaw(`"${tableName}"`);
    for (const r of rows) {
      await connector.query(
        sqlTag`INSERT INTO ${table} ("name", "profile") VALUES (${r.name}, ${r.profile})`,
      );
    }
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("extracts a nested JSON field and compares it (eq)", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.contact.email.eq("alice@example.com"))
      .getRawMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("alice");
  });

  it("extracts a nested JSON field and compares with gt/lt (numeric)", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.personal.age.gt(25))
      .getRawMany();
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["alice", "carol"]);
  });

  it("supports .in() over an extracted JSON field", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.role.in(["admin", "editor"]))
      .getRawMany();
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["alice", "bob"]);
  });

  it("supports .isNull() on a missing nested field", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.contact.email.isNull())
      .getRawMany();
    // Only "dave" has no profile.contact.email
    expect(rows.map((r: any) => r.name)).toEqual(["dave"]);
  });

  it("supports .path() for bracket/dot paths (array index)", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.path("tags[0]").eq("red"))
      .getRawMany();
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["alice", "bob"]);
  });

  it("supports .hasKey() for existence checks", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.hasKey("contact"))
      .getRawMany();
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["alice", "bob", "carol"]);
  });

  it("supports .arrayLength() for array length comparisons", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.tags.arrayLength().gt(1))
      .getRawMany();
    expect(rows.map((r: any) => r.name)).toEqual(["alice"]);
  });

  it("supports .typeOf() comparisons", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.tags.typeOf().eq("array"))
      .getRawMany();
    // alice, bob, carol all have a tags array; dave has no tags key
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["alice", "bob", "carol"]);
  });

  it("supports scalar .contains() via equality fallback on SQLite", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.role.contains("admin"))
      .getRawMany();
    expect(rows.map((r: any) => r.name)).toEqual(["alice"]);
  });

  it("combines JSON conditions with regular column filters", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.personal.age.gte(22))
      .andWhere(u.name.like("%a%"))
      .getRawMany();
    const names = rows.map((r: any) => r.name).sort();
    // alice (age=30, name=alice) and carol (age=45, name=carol) match both.
    // dave has no profile.personal.age so fails the JSON filter.
    // bob (age=22) fails name.like("%a%").
    expect(names).toEqual(["alice", "carol"]);
  });
});
