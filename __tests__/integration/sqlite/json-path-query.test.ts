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
          contact: { email: "alice@example.com", phone: "010-1" },
          personal: { age: 30, city: "Seoul" },
          role: "admin",
          tags: ["red", "blue", "green"],
          items: [
            { name: "hat", price: 10 },
            { name: "shoe", price: 20 },
          ],
        }),
      },
      {
        name: "bob",
        profile: JSON.stringify({
          contact: { email: "bob@example.com" },
          personal: { age: 22, city: "Seoul" },
          role: "editor",
          tags: ["red"],
          items: [{ name: "hat", price: 12 }],
        }),
      },
      {
        name: "carol",
        profile: JSON.stringify({
          contact: { email: "carol@example.com" },
          personal: { age: 45, city: "Busan" },
          role: "viewer",
          tags: [],
          items: [],
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

  // ─── Added coverage: operator/edge-case suite ─────────────────────────

  it("supports .neq()/.ne() to exclude a value", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.role.neq("viewer"))
      .getRawMany();
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["alice", "bob"]);
  });

  it("supports .gte()/.lte() chained comparisons", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const gte = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.personal.age.gte(30))
      .getRawMany();
    expect(gte.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);

    const lte = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.personal.age.lte(22))
      .getRawMany();
    expect(lte.map((r: any) => r.name)).toEqual(["bob"]);
  });

  it("supports .between() for numeric ranges", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.personal.age.between(20, 35))
      .getRawMany();
    expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);
  });

  it("supports .notIn() negated set filtering", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.role.notIn(["admin", "editor"]))
      .getRawMany();
    expect(rows.map((r: any) => r.name).sort()).toEqual(["carol", "dave"]);
  });

  it("short-circuits .in([]) to an empty result", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.role.in([]))
      .getRawMany();
    expect(rows).toHaveLength(0);
  });

  it("supports .isNotNull() for present nested fields", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.personal.city.isNotNull())
      .getRawMany();
    expect(rows.map((r: any) => r.name).sort()).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("supports .like()/.notLike() on extracted strings", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const like = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.contact.email.like("%@example.com"))
      .getRawMany();
    expect(like.map((r: any) => r.name).sort()).toEqual([
      "alice",
      "bob",
      "carol",
    ]);

    const notLike = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.contact.email.notLike("alice%"))
      .getRawMany();
    // dave's extract is NULL, so `NULL NOT LIKE ...` → NULL → excluded.
    expect(notLike.map((r: any) => r.name).sort()).toEqual(["bob", "carol"]);
  });

  it("supports numeric proxy access as array index (items[0].price)", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.items[0].price.gte(12))
      .getRawMany();
    // alice.items[0].price=10, bob.items[0].price=12, carol.items=[]
    expect(rows.map((r: any) => r.name)).toEqual(["bob"]);
  });

  it("supports nested hasKey() inside a nested object path", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.contact.hasKey("phone"))
      .getRawMany();
    expect(rows.map((r: any) => r.name)).toEqual(["alice"]);
  });

  it("supports .arrayLength().eq(0) for empty arrays", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.tags.arrayLength().eq(0))
      .getRawMany();
    expect(rows.map((r: any) => r.name)).toEqual(["carol"]);
  });

  it("supports .typeOf() on non-array values", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.contact.typeOf().eq("object"))
      .getRawMany();
    expect(rows.map((r: any) => r.name).sort()).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("refuses .contains() with object/array candidates on SQLite", async () => {
    const u = qAlias(EntityClass, "u") as any;
    // Building the condition is fine; resolution (at getRawMany) is where
    // the dialect throws. Wrap execution in an await-expect.
    await expect(async () => {
      await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.contains({ email: "alice@example.com" }))
        .getRawMany();
    }).rejects.toThrow(/not supported on SQLite/i);

    await expect(async () => {
      await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.tags.contains(["red"]))
        .getRawMany();
    }).rejects.toThrow(/not supported on SQLite/i);
  });

  it("combines JSON predicates via orWhere()", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.role.eq("admin"))
      .orWhere(u.profile.personal.age.gt(40))
      .getRawMany();
    expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);
  });

  it("parameterizes injected values (SQL injection safety)", async () => {
    const { em } = conn;
    const u = qAlias(EntityClass, "u") as any;
    const evil = "alice@example.com' OR 1=1 --";
    const rows = await em
      .createQueryBuilder(EntityClass, "u")
      .where(u.profile.contact.email.eq(evil))
      .getRawMany();
    expect(rows).toHaveLength(0);
  });
});
