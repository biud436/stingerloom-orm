import { DbVersion } from "../../src/dialects/DbVersion";
import { resolveMySqlCapabilities } from "../../src/dialects/resolveCapabilities";
import { dialectTypes } from "../../src/introspection/catalog";
import {
  OrmColumnType,
  TypeOracle,
} from "../../src/introspection/lowering/TypeSelection";
import type { IntrospectionDialect } from "../../src/introspection/TypeMapper";

/**
 * The type half of the introspection round trip, checked without a database.
 *
 * Every column type this ORM can create is rendered through the dialect's real
 * column definition builder, parsed back by the introspection parser, and
 * handed to the type selection. The selection must land on an ORM type that
 * creates the *identical* DDL — the fixed point that makes "generate entities,
 * then let synchronize own the schema" safe to repeat — and must call the
 * mapping faithful. A parser that misreads the builder's spelling, or a
 * candidate list that misses a type, fails here for the exact type.
 */
const ORM_TYPES: OrmColumnType[] = [
  { type: "int" },
  { type: "number" },
  { type: "bigint" },
  { type: "float" },
  { type: "double" },
  { type: "double", precision: 12, scale: 4 },
  { type: "double", precision: 10, scale: 0 },
  { type: "boolean" },
  { type: "varchar", length: 255 },
  { type: "varchar", length: 36 },
  { type: "char", length: 10 },
  { type: "text" },
  { type: "longtext" },
  { type: "uuid" },
  { type: "blob" },
  { type: "json" },
  { type: "jsonb" },
  { type: "date" },
  { type: "datetime" },
  { type: "timestamp" },
  { type: "timestamptz" },
  { type: "enum", enumValues: ["draft", "it's", "back\\slash"], enumName: "post_status" },
  { type: "array", arrayElementType: "int" },
  { type: "array", arrayElementType: "varchar", length: 20 },
  { type: "array", arrayElementType: "double", precision: 8, scale: 3 },
  { type: "array", arrayElementType: "uuid" },
];

const at = { tableName: "posts", columnName: "col" };

describe.each<IntrospectionDialect>(["postgres", "mysql", "sqlite"])(
  "TypeOracle fixed point on %s",
  (dialect) => {
    const types = dialectTypes(dialect);
    const oracle = new TypeOracle(types);

    it.each(ORM_TYPES.map((orm) => [label(orm), orm] as const))(
      "%s is recovered to the same DDL",
      (_label, orm) => {
        const { ddl, created } = oracle.render(orm, at);
        const choice = oracle.choose(created, at);

        // The same type — spelled identically everywhere except SQLite's
        // uuid, created as VARCHAR(36) and recovered as TEXT(36).
        expect(choice.created).toEqual(created);
        if (!(dialect === "sqlite" && orm.type === "uuid")) {
          expect(choice.createdDdl).toBe(ddl);
        }
        expect(choice.fidelity).toBe("exact");
        // And once more from the recovered type: the loop has stopped moving.
        expect(oracle.choose(choice.created, at).orm).toEqual(choice.orm);
      },
    );
  },
);

describe("TypeOracle reports what it cannot recreate", () => {
  const cases: Array<[IntrospectionDialect, string, RegExp]> = [
    ["postgres", "double precision", /^REAL$/],
    ["postgres", "smallint", /^INTEGER$/],
    ["postgres", "numeric", /^NUMERIC\(10, 2\)$/],
    ["postgres", "timestamp(3) without time zone", /^TIMESTAMP$/],
    ["postgres", "inet", /^TEXT$/],
    ["postgres", "interval", /^TEXT$/],
    ["mysql", "double", /^FLOAT$/],
    ["mysql", "int(10) unsigned", /^INT$/],
    ["mysql", "mediumtext", /^LONGTEXT$/],
    ["mysql", "tinyint(4)", /^INT$/],
    ["mysql", "datetime(3)", /^DATETIME$/],
    ["mysql", "mediumblob", /^BLOB$/],
    ["mysql", "time", /^TEXT$/],
    ["mysql", "set('a','b')", /^TEXT$/],
  ];

  it.each(cases)("%s %s", (dialect, native, createdAs) => {
    const types = dialectTypes(dialect);
    const oracle = new TypeOracle(types);
    const choice = oracle.choose(types.parseType(native), at);
    expect(choice.fidelity).toBe("different");
    expect(choice.createdDdl).toMatch(createdAs);
  });

  it("keeps floating-point semantics for a double precision column", () => {
    const types = dialectTypes("postgres");
    const choice = new TypeOracle(types).choose(types.parseType("double precision"), at);
    expect(choice.orm.type).toBe("float");
  });

  it("judges SQLite declarations by the affinity SQLite keeps", () => {
    const types = dialectTypes("sqlite");
    const oracle = new TypeOracle(types);
    const fidelity = (declared: string) => oracle.choose(types.parseType(declared), at).fidelity;
    // Same affinity: INTEGER behaves as NUMERIC, an unbounded VARCHAR as TEXT.
    for (const declared of ["BOOLEAN", "VARCHAR", "NVARCHAR", "SMALLINT"]) {
      expect([declared, fidelity(declared)]).toEqual([declared, "equivalent"]);
    }
    // NUMERIC affinity turns '123' into an integer; the TEXT this ORM
    // declares keeps it text.
    for (const declared of ["DATETIME", "DATE", "JSON", "UUID", "DECIMAL(10,2)"]) {
      expect([declared, fidelity(declared)]).toEqual([declared, "different"]);
    }
  });

  it("uses the server's capabilities: MariaDB 10.7+ creates a native UUID", () => {
    const types = dialectTypes("mysql");
    const maria = new TypeOracle(types, {
      capabilities: resolveMySqlCapabilities(DbVersion.parse("10.11.6-MariaDB"), true),
    });
    const mysql = new TypeOracle(types);

    const uuid = types.parseType("uuid");
    expect(maria.choose(uuid, at)).toMatchObject({ createdDdl: "UUID", fidelity: "exact" });
    expect(mysql.choose(uuid, at).fidelity).toBe("different");
  });
});

function label(orm: OrmColumnType): string {
  const params = [
    orm.length !== undefined ? `length ${orm.length}` : "",
    orm.precision !== undefined ? `(${orm.precision}, ${orm.scale})` : "",
    orm.arrayElementType ? `of ${orm.arrayElementType}` : "",
  ].filter(Boolean);
  return `${orm.type}${params.length ? ` ${params.join(" ")}` : ""}`;
}
