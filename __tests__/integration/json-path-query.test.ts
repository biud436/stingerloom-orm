/**
 * Dual-driver integration test for the JSON path QueryDSL.
 *
 * Runs the same scenarios against MySQL and PostgreSQL via the shared
 * `describe.each(getTestDrivers())` pattern. Each dialect's
 * `DialectExpression` is exercised end-to-end through `qAlias()` and
 * `SelectQueryBuilder.where()` so that `JSON_EXTRACT`/`JSON_CONTAINS`
 * (MySQL) and `#>>`/`@>` (PostgreSQL) produce the expected row sets.
 *
 * Requirements:
 *   INTEGRATION_TEST=true (jest config gate)
 *   A reachable MySQL and/or PostgreSQL; disable individually via
 *     INTEGRATION_TEST_MYSQL=false  /  INTEGRATION_TEST_POSTGRES=false
 */

import "reflect-metadata";
import sqlTag, { raw as sqlRaw } from "sql-template-tag";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  qAlias,
} from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { DatabaseClient } from "../../src/DatabaseClient";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { generateTableName } from "./helpers/create-test-entity";
import { getTestDrivers } from "./helpers/driver-config";

const drivers = getTestDrivers();

// MySQL (MariaDB/MySQL 8) returns UPPERCASE JSON type names (`ARRAY`,
// `OBJECT`, `STRING`, ...) while PostgreSQL's `jsonb_typeof` is lowercase.
function expectedType(driver: "mysql" | "postgres", t: string): string {
  return driver === "mysql" ? t.toUpperCase() : t;
}

describe.each(drivers)(
  "[Integration] $label: JSON path QueryDSL (qAlias)",
  ({ type, options }) => {
    let conn: TestConnectionResult;
    let tableName: string;
    let EntityClass: new () => any;

    beforeAll(async () => {
      tableName = generateTableName("json_dsl");

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          getScannerInstance(ColumnScanner).clear();

          const DynClass = class {} as any;
          Object.defineProperty(DynClass, "name", {
            value: tableName,
            writable: false,
          });

          Reflect.defineMetadata(
            "design:type",
            Number,
            DynClass.prototype,
            "id",
          );
          PrimaryGeneratedColumn()(DynClass.prototype, "id");

          Reflect.defineMetadata(
            "design:type",
            String,
            DynClass.prototype,
            "name",
          );
          Column()(DynClass.prototype, "name");

          // `profile` is `jsonb` on PostgreSQL (so containment/hasKey use the
          // native operators) and `json` on MySQL.
          Reflect.defineMetadata(
            "design:type",
            Object,
            DynClass.prototype,
            "profile",
          );
          const jsonType = type === "postgres" ? "jsonb" : "json";
          Column({ type: jsonType, nullable: true })(
            DynClass.prototype,
            "profile",
          );

          Entity()(DynClass);
          EntityClass = DynClass;
          return { entities: [DynClass] };
        },
      );

      const connector = DatabaseClient.getInstance().getConnection();

      // Identifier quoting differs by driver: MySQL uses backticks,
      // PostgreSQL uses double quotes.
      const q = type === "mysql" ? "`" : '"';
      const tableId = sqlRaw(`${q}${tableName}${q}`);
      const nameCol = sqlRaw(`${q}name${q}`);
      const profileCol = sqlRaw(`${q}profile${q}`);

      const rows = [
        {
          name: "alice",
          profile: {
            contact: { email: "alice@example.com", phone: "010-1" },
            personal: { age: 30, city: "Seoul" },
            role: "admin",
            tags: ["red", "blue", "green"],
            items: [
              { name: "hat", price: 10 },
              { name: "shoe", price: 20 },
            ],
          },
        },
        {
          name: "bob",
          profile: {
            contact: { email: "bob@example.com" },
            personal: { age: 22, city: "Seoul" },
            role: "editor",
            tags: ["red"],
            items: [{ name: "hat", price: 12 }],
          },
        },
        {
          name: "carol",
          profile: {
            contact: { email: "carol@example.com" },
            personal: { age: 45, city: "Busan" },
            role: "viewer",
            tags: [],
            items: [],
          },
        },
        {
          // Missing nested `contact`/`personal` to exercise isNull / isNotNull.
          name: "dave",
          profile: { role: "viewer" },
        },
      ];

      for (const r of rows) {
        const json = JSON.stringify(r.profile);
        if (type === "postgres") {
          await connector.query(
            sqlTag`INSERT INTO ${tableId} (${nameCol}, ${profileCol}) VALUES (${r.name}, ${json}::jsonb)`,
          );
        } else {
          await connector.query(
            sqlTag`INSERT INTO ${tableId} (${nameCol}, ${profileCol}) VALUES (${r.name}, ${json})`,
          );
        }
      }
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(tableName);
      } catch {
        // ignore
      }
      await conn.cleanup();
    }, 15000);

    // ─── comparison operators ─────────────────────────────────────────────

    it("eq() extracts a nested scalar and compares it", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.email.eq("alice@example.com"))
        .getRawMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("alice");
    });

    it("neq()/ne() excludes the matching row", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rowsA = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.role.neq("viewer"))
        .getRawMany();
      expect(rowsA.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);

      const rowsB = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.role.ne("admin"))
        .getRawMany();
      expect(rowsB.map((r: any) => r.name).sort()).toEqual([
        "bob",
        "carol",
        "dave",
      ]);
    });

    it("gt()/gte()/lt()/lte() compare numeric fields across rows", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const gt = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.personal.age.gt(25))
        .getRawMany();
      expect(gt.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);

      const gte = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.personal.age.gte(30))
        .getRawMany();
      expect(gte.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);

      const lt = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.personal.age.lt(30))
        .getRawMany();
      expect(lt.map((r: any) => r.name)).toEqual(["bob"]);

      const lte = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.personal.age.lte(22))
        .getRawMany();
      expect(lte.map((r: any) => r.name)).toEqual(["bob"]);
    });

    it("between() filters numeric ranges", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.personal.age.between(20, 35))
        .getRawMany();
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);
    });

    it("like()/notLike() match pattern on extracted string", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const like = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.email.like("%@example.com"))
        .getRawMany();
      expect(like.map((r: any) => r.name).sort()).toEqual([
        "alice",
        "bob",
        "carol",
      ]);

      const notLike = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.email.notLike("alice%"))
        .getRawMany();
      // only rows WITH a contact.email that is not alice; dave has no email
      // → extract is NULL and `NULL NOT LIKE ...` is NULL, so dave is excluded.
      expect(notLike.map((r: any) => r.name).sort()).toEqual(["bob", "carol"]);
    });

    // ─── set membership ────────────────────────────────────────────────────

    it("in()/notIn() filter over a value set", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rowsIn = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.role.in(["admin", "editor"]))
        .getRawMany();
      expect(rowsIn.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);

      const rowsNotIn = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.role.notIn(["admin", "editor"]))
        .getRawMany();
      expect(rowsNotIn.map((r: any) => r.name).sort()).toEqual([
        "carol",
        "dave",
      ]);
    });

    it("in([]) short-circuits to no rows", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.role.in([]))
        .getRawMany();
      expect(rows).toHaveLength(0);
    });

    // ─── null predicates ──────────────────────────────────────────────────

    it("isNull()/isNotNull() detect missing nested fields", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const missing = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.email.isNull())
        .getRawMany();
      expect(missing.map((r: any) => r.name)).toEqual(["dave"]);

      const present = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.personal.city.isNotNull())
        .getRawMany();
      expect(present.map((r: any) => r.name).sort()).toEqual([
        "alice",
        "bob",
        "carol",
      ]);
    });

    // ─── explicit path(), array indexing ──────────────────────────────────

    it("path() parses dot/bracket notation for array/object access", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.path("tags[0]").eq("red"))
        .getRawMany();
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);

      // Nested object inside array index
      const rows2 = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.path("items[0].name").eq("hat"))
        .getRawMany();
      expect(rows2.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);
    });

    it("numeric proxy access works as array indexing (items[0].price)", async () => {
      const u = qAlias(EntityClass, "u") as any;
      // Proxy get with numeric string → Number path segment.
      // alice.items[0].price = 10, bob.items[0].price = 12, carol.items = [].
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.items[0].price.gte(12))
        .getRawMany();
      expect(rows.map((r: any) => r.name)).toEqual(["bob"]);

      const rows2 = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.items[0].price.gte(10))
        .getRawMany();
      expect(rows2.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);
    });

    // ─── hasKey / arrayLength / typeOf ────────────────────────────────────

    it("hasKey() checks object key existence at the path", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.hasKey("contact"))
        .getRawMany();
      expect(rows.map((r: any) => r.name).sort()).toEqual([
        "alice",
        "bob",
        "carol",
      ]);

      const rowsNested = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.hasKey("phone"))
        .getRawMany();
      expect(rowsNested.map((r: any) => r.name)).toEqual(["alice"]);
    });

    it("arrayLength() compares array sizes", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const gt1 = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.tags.arrayLength().gt(1))
        .getRawMany();
      expect(gt1.map((r: any) => r.name)).toEqual(["alice"]);

      const eq0 = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.tags.arrayLength().eq(0))
        .getRawMany();
      expect(eq0.map((r: any) => r.name)).toEqual(["carol"]);

      const gte1 = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.tags.arrayLength().gte(1))
        .getRawMany();
      expect(gte1.map((r: any) => r.name).sort()).toEqual(["alice", "bob"]);
    });

    it("typeOf() returns the JSON type at the given path", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const isArray = expectedType(type, "array");
      const isObject = expectedType(type, "object");

      const arrRows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.tags.typeOf().eq(isArray))
        .getRawMany();
      expect(arrRows.map((r: any) => r.name).sort()).toEqual([
        "alice",
        "bob",
        "carol",
      ]);

      const objRows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.typeOf().eq(isObject))
        .getRawMany();
      expect(objRows.map((r: any) => r.name).sort()).toEqual([
        "alice",
        "bob",
        "carol",
      ]);
    });

    // ─── JSON containment ─────────────────────────────────────────────────

    it("contains() checks scalar containment in an array path", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.tags.contains("blue"))
        .getRawMany();
      expect(rows.map((r: any) => r.name)).toEqual(["alice"]);
    });

    it("contains() with an object candidate matches subdocuments", async () => {
      const u = qAlias(EntityClass, "u") as any;
      // MySQL JSON_CONTAINS(<sub-doc>) and PG `@>` both support object
      // containment. SQLite does not — that branch is covered separately.
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.contains({ email: "alice@example.com" }))
        .getRawMany();
      expect(rows.map((r: any) => r.name)).toEqual(["alice"]);
    });

    it("contains() with an array candidate checks array containment", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.tags.contains(["red", "blue"]))
        .getRawMany();
      // alice has ["red","blue","green"] so contains ["red","blue"].
      // bob has only ["red"]. carol has []. dave has no tags key.
      expect(rows.map((r: any) => r.name)).toEqual(["alice"]);
    });

    // ─── combinators ──────────────────────────────────────────────────────

    it("andWhere() combines JSON predicates with regular column filters", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.personal.age.gte(22))
        .andWhere(u.name.like("%a%"))
        .getRawMany();
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);
    });

    it("orWhere() unions two JSON predicates", async () => {
      const u = qAlias(EntityClass, "u") as any;
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.role.eq("admin"))
        .orWhere(u.profile.personal.age.gt(40))
        .getRawMany();
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "carol"]);
    });

    // ─── SQL injection safety ─────────────────────────────────────────────

    it("rejects injection attempts via bound values (values are parameterized)", async () => {
      const u = qAlias(EntityClass, "u") as any;
      // A value that would be catastrophic if interpolated raw.
      const evil = "alice@example.com' OR 1=1 -- ";
      const rows = await conn.em
        .createQueryBuilder(EntityClass, "u")
        .where(u.profile.contact.email.eq(evil))
        .getRawMany();
      // No row matches — proves the value was bound, not concatenated.
      expect(rows).toHaveLength(0);
    });
  },
);
