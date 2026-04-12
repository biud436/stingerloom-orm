/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Column } from "../../src/decorators/Column";
import { Entity } from "../../src/decorators/Entity";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import {
  qAlias,
  ColumnExpression,
} from "../../src/core/SelectQueryBuilder";
import {
  JsonPathCondition,
  JsonScalarExpression,
  isJsonPathCondition,
  isJsonPathExpression,
  parseJsonPath,
  makeJsonPathExpression,
} from "../../src/core/expressions/JsonPathExpression";
import { PostgresExpression } from "../../src/dialects/expression/PostgresExpression";
import { MySqlExpression } from "../../src/dialects/expression/MySqlExpression";
import { SqliteExpression } from "../../src/dialects/expression/SqliteExpression";
import { OrmError } from "../../src/errors/OrmError";

@Entity()
class JsonFixture {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 64 })
  name!: string;

  @Column({ type: "jsonb", nullable: true })
  profile!: {
    contact?: { email: string; phone?: string };
    personal?: { age: number; city?: string };
    tags?: string[];
    role?: string;
  };

  @Column({ type: "json", nullable: true })
  preferences!: Record<string, unknown>;
}

describe("parseJsonPath", () => {
  it("parses dot-separated identifier segments", () => {
    expect(parseJsonPath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("parses numeric array indices", () => {
    expect(parseJsonPath("tags[0].name")).toEqual(["tags", 0, "name"]);
  });

  it("parses quoted segments with special characters", () => {
    expect(parseJsonPath(`items["weird key"][2].x`)).toEqual([
      "items",
      "weird key",
      2,
      "x",
    ]);
  });

  it("unescapes backslash-escaped characters inside quoted segments", () => {
    expect(parseJsonPath(`x["a\\"b"]`)).toEqual(["x", 'a"b']);
  });

  it("returns empty array for empty input", () => {
    expect(parseJsonPath("")).toEqual([]);
  });
});

describe("qAlias — JSON column detection", () => {
  it("returns a JsonPathExpression for @Column({ type: 'jsonb' }) properties", () => {
    const u = qAlias(JsonFixture, "u");
    expect(isJsonPathExpression(u.profile)).toBe(true);
  });

  it("returns a JsonPathExpression for @Column({ type: 'json' }) properties", () => {
    const u = qAlias(JsonFixture, "u");
    expect(isJsonPathExpression(u.preferences)).toBe(true);
  });

  it("returns a ColumnExpression for non-JSON columns", () => {
    const u = qAlias(JsonFixture, "u");
    expect(u.name).toBeInstanceOf(ColumnExpression);
    expect(u.id).toBeInstanceOf(ColumnExpression);
  });

  it("keeps `_alias` / `_entity` / `col()` unaffected", () => {
    const u = qAlias(JsonFixture, "u") as any;
    expect(u._alias).toBe("u");
    expect(u._entity).toBe(JsonFixture);
    expect(typeof u.col).toBe("function");
    expect(u.col("profile")).toBe("u.profile");
  });
});

describe("JsonPathExpression — path building via proxy", () => {
  it("accumulates path segments through property access", () => {
    const u = qAlias(JsonFixture, "u");
    const cond = u.profile.contact.email.eq("alice@example.com");
    expect(isJsonPathCondition(cond)).toBe(true);
    expect(cond.ref).toBe("u.profile");
    expect(cond.path).toEqual(["contact", "email"]);
    expect(cond.kind).toBe("compare");
    expect(cond.operator).toBe("=");
    expect(cond.value).toBe("alice@example.com");
  });

  it("treats numeric property accesses as array indices", () => {
    const u = qAlias(JsonFixture, "u");
    // Accessing via bracket notation for array indices
    const cond = (u.profile.tags as any)[0].eq("admin");
    expect(cond.path).toEqual(["tags", 0]);
  });

  it("supports .path() for dot-bracket string navigation", () => {
    const u = qAlias(JsonFixture, "u");
    const cond = u.profile.path("contact.tags[0].name").eq("x");
    expect(cond.path).toEqual(["contact", "tags", 0, "name"]);
  });

  it("composes .path() with prior proxy navigation", () => {
    const u = qAlias(JsonFixture, "u");
    const cond = u.profile.personal.path("history[1].city").eq("Busan");
    expect(cond.path).toEqual(["personal", "history", 1, "city"]);
  });

  it("each operator produces a JsonPathCondition with correct kind", () => {
    const u = qAlias(JsonFixture, "u");
    expect(u.profile.x.eq(1).operator).toBe("=");
    expect(u.profile.x.neq(1).operator).toBe("!=");
    expect(u.profile.x.gt(1).operator).toBe(">");
    expect(u.profile.x.gte(1).operator).toBe(">=");
    expect(u.profile.x.lt(1).operator).toBe("<");
    expect(u.profile.x.lte(1).operator).toBe("<=");
    expect(u.profile.x.like("%").operator).toBe("LIKE");
    expect(u.profile.x.notLike("%").operator).toBe("NOT LIKE");
    expect(u.profile.x.in([1, 2]).kind).toBe("in");
    expect(u.profile.x.notIn([1, 2]).kind).toBe("notIn");
    expect(u.profile.x.isNull().kind).toBe("isNull");
    expect(u.profile.x.isNotNull().kind).toBe("isNotNull");
    expect(u.profile.x.between(1, 10).kind).toBe("between");
    expect(u.profile.x.contains({ k: "v" }).kind).toBe("contains");
    expect(u.profile.x.hasKey("foo").kind).toBe("hasKey");
  });

  it("arrayLength() returns a JsonScalarExpression with compare methods", () => {
    const u = qAlias(JsonFixture, "u");
    const scalar = u.profile.tags.arrayLength();
    expect(scalar).toBeInstanceOf(JsonScalarExpression);
    const cond = scalar.gt(3);
    expect(cond.kind).toBe("arrayLengthCompare");
    expect(cond.operator).toBe(">");
    expect(cond.value).toBe(3);
  });

  it("typeOf() returns a JsonScalarExpression", () => {
    const u = qAlias(JsonFixture, "u");
    const cond = u.profile.tags.typeOf().eq("array");
    expect(cond.kind).toBe("typeOfCompare");
    expect(cond.operator).toBe("=");
    expect(cond.value).toBe("array");
  });
});

describe("PostgresExpression — JSON methods", () => {
  const expr = new PostgresExpression();

  it("jsonExtract with asText=true uses #>> operator", () => {
    const s = expr.jsonExtract('"u"."profile"', ["contact", "email"], true);
    expect(s.sql).toContain("#>>");
    expect(s.sql).toContain('"u"."profile"');
    // The ARRAY placeholders each bind as a parameter
    expect(s.values).toEqual(["contact", "email"]);
  });

  it("jsonExtract with asText=false uses #> operator", () => {
    const s = expr.jsonExtract('"u"."profile"', ["contact"], false);
    expect(s.sql).toContain(" #> ");
    expect(s.sql).not.toContain("#>>");
  });

  it("jsonExtract with empty path returns column as-is (no path array)", () => {
    const s = expr.jsonExtract('"u"."profile"', [], true);
    expect(s.sql.trim()).toBe('"u"."profile"');
    expect(s.values).toEqual([]);
  });

  it("jsonContains uses @> with jsonb cast on a parameterized candidate", () => {
    const s = expr.jsonContains('"u"."profile"', ["contact"], { role: "admin" });
    expect(s.sql).toContain("@>");
    expect(s.sql).toContain("::jsonb");
    expect(s.values).toContain(JSON.stringify({ role: "admin" }));
  });

  it("jsonHasKey uses the ? operator", () => {
    const s = expr.jsonHasKey('"u"."profile"', ["contact"], "email");
    expect(s.sql).toMatch(/ \? /);
    expect(s.values).toContain("email");
  });

  it("jsonArrayLength wraps with jsonb_array_length()", () => {
    const s = expr.jsonArrayLength('"u"."profile"', ["tags"]);
    expect(s.sql).toContain("jsonb_array_length(");
  });

  it("jsonTypeOf wraps with jsonb_typeof()", () => {
    const s = expr.jsonTypeOf('"u"."profile"', ["contact"]);
    expect(s.sql).toContain("jsonb_typeof(");
  });
});

describe("MySqlExpression — JSON methods", () => {
  const expr = new MySqlExpression();

  it("jsonExtract with asText=true wraps with JSON_UNQUOTE(JSON_EXTRACT(...))", () => {
    const s = expr.jsonExtract("`u`.`profile`", ["contact", "email"], true);
    expect(s.sql).toContain("JSON_UNQUOTE(JSON_EXTRACT(");
    expect(s.values).toEqual(["$.contact.email"]);
  });

  it("jsonExtract with asText=false uses JSON_EXTRACT only", () => {
    const s = expr.jsonExtract("`u`.`profile`", ["contact"], false);
    expect(s.sql).toContain("JSON_EXTRACT(");
    expect(s.sql).not.toContain("JSON_UNQUOTE");
  });

  it("serializes array indices with bracket notation", () => {
    const s = expr.jsonExtract("`u`.`profile`", ["tags", 0, "name"], true);
    expect(s.values).toEqual(["$.tags[0].name"]);
  });

  it("quotes non-identifier segments", () => {
    const s = expr.jsonExtract("`u`.`profile`", ["weird key"], true);
    expect(s.values).toEqual([`$."weird key"`]);
  });

  it("jsonContains uses JSON_CONTAINS(col, candidate, path)", () => {
    const s = expr.jsonContains("`u`.`profile`", ["contact"], { role: "admin" });
    expect(s.sql).toContain("JSON_CONTAINS(");
    expect(s.values).toContain(JSON.stringify({ role: "admin" }));
    expect(s.values).toContain("$.contact");
  });

  it("jsonHasKey uses JSON_CONTAINS_PATH with 'one' mode", () => {
    const s = expr.jsonHasKey("`u`.`profile`", ["contact"], "email");
    expect(s.sql).toContain("JSON_CONTAINS_PATH(");
    expect(s.sql).toContain("'one'");
    expect(s.values).toContain("$.contact.email");
  });

  it("jsonArrayLength with empty path uses one-arg form", () => {
    const s = expr.jsonArrayLength("`u`.`tags`", []);
    expect(s.sql).toBe("JSON_LENGTH(`u`.`tags`)");
  });

  it("jsonArrayLength with non-empty path passes the JSON path as second arg", () => {
    const s = expr.jsonArrayLength("`u`.`profile`", ["tags"]);
    expect(s.sql).toContain("JSON_LENGTH(");
    expect(s.values).toEqual(["$.tags"]);
  });
});

describe("SqliteExpression — JSON methods", () => {
  const expr = new SqliteExpression();

  it("jsonExtract uses json_extract()", () => {
    const s = expr.jsonExtract('"u"."profile"', ["contact", "email"], true);
    expect(s.sql).toContain("json_extract(");
    expect(s.values).toEqual(["$.contact.email"]);
  });

  it("jsonHasKey uses 'IS NOT NULL' on nested json_extract", () => {
    const s = expr.jsonHasKey('"u"."profile"', ["contact"], "email");
    expect(s.sql).toContain("IS NOT NULL");
    expect(s.values).toContain("$.contact.email");
  });

  it("jsonContains falls back to equality for scalars", () => {
    const s = expr.jsonContains('"u"."profile"', ["role"], "admin");
    expect(s.sql).toContain("json_extract(");
    expect(s.sql).toContain(" = ");
    expect(s.values).toContain("admin");
  });

  it("jsonContains throws OrmError for object values", () => {
    expect(() =>
      expr.jsonContains('"u"."profile"', ["contact"], { k: "v" }),
    ).toThrow(OrmError);
  });

  it("jsonContains throws OrmError for array values", () => {
    expect(() =>
      expr.jsonContains('"u"."profile"', ["tags"], [1, 2]),
    ).toThrow(OrmError);
  });

  it("jsonArrayLength uses json_array_length()", () => {
    const s = expr.jsonArrayLength('"u"."tags"', []);
    expect(s.sql).toContain("json_array_length(");
  });

  it("jsonTypeOf uses json_type()", () => {
    const s = expr.jsonTypeOf('"u"."profile"', ["contact"]);
    expect(s.sql).toContain("json_type(");
  });
});

describe("JsonPathCondition.resolve()", () => {
  const pg = new PostgresExpression();
  const resolver = (ref: string) => {
    const [alias, prop] = ref.split(".");
    return `"${alias}"."${prop}"`;
  };

  it("resolves a compare condition through DialectExpression.jsonExtract", () => {
    const cond = makeJsonPathExpression("u.profile").contact.email.eq(
      "alice@example.com",
    );
    const sql = (cond as JsonPathCondition).resolve(resolver, pg);
    expect(sql.sql).toContain("#>>");
    expect(sql.values).toContain("alice@example.com");
    expect(sql.values).toContain("contact");
    expect(sql.values).toContain("email");
  });

  it("resolves an isNull condition to `<extract> IS NULL`", () => {
    const cond = makeJsonPathExpression("u.profile").contact.email.isNull();
    const sql = (cond as JsonPathCondition).resolve(resolver, pg);
    expect(sql.sql).toContain("IS NULL");
  });

  it("resolves an in() condition to `<extract> IN (...)`", () => {
    const cond = makeJsonPathExpression("u.profile").role.in(["admin", "editor"]);
    const sql = (cond as JsonPathCondition).resolve(resolver, pg);
    expect(sql.sql).toContain("IN (");
    expect(sql.values).toContain("admin");
    expect(sql.values).toContain("editor");
  });

  it("resolves an empty in() to `1 = 0` (contradiction)", () => {
    const cond = makeJsonPathExpression("u.profile").role.in([]);
    const sql = (cond as JsonPathCondition).resolve(resolver, pg);
    expect(sql.sql).toBe("1 = 0");
  });

  it("resolves an empty notIn() to `1 = 1` (tautology)", () => {
    const cond = makeJsonPathExpression("u.profile").role.notIn([]);
    const sql = (cond as JsonPathCondition).resolve(resolver, pg);
    expect(sql.sql).toBe("1 = 1");
  });

  it("resolves between() to `<extract> BETWEEN ? AND ?`", () => {
    const cond = makeJsonPathExpression("u.profile").personal.age.between(18, 65);
    const sql = (cond as JsonPathCondition).resolve(resolver, pg);
    expect(sql.sql).toContain("BETWEEN");
    expect(sql.values).toEqual(expect.arrayContaining([18, 65]));
  });

  it("resolves arrayLength comparisons through jsonArrayLength", () => {
    const cond = makeJsonPathExpression("u.profile").tags.arrayLength().gt(3);
    const sql = cond.resolve(resolver, pg);
    expect(sql.sql).toContain("jsonb_array_length(");
    expect(sql.sql).toContain(" > ");
    expect(sql.values).toContain(3);
  });

  it("resolves typeOf comparisons through jsonTypeOf", () => {
    const cond = makeJsonPathExpression("u.profile").tags.typeOf().eq("array");
    const sql = cond.resolve(resolver, pg);
    expect(sql.sql).toContain("jsonb_typeof(");
    expect(sql.values).toContain("array");
  });

  it("resolves contains() and hasKey() through dialect methods", () => {
    const c1 = makeJsonPathExpression("u.profile").contains({ role: "admin" });
    const s1 = c1.resolve(resolver, pg);
    expect(s1.sql).toContain("@>");

    const c2 = makeJsonPathExpression("u.profile").hasKey("contact");
    const s2 = c2.resolve(resolver, pg);
    expect(s2.sql).toMatch(/ \? /);
  });
});

describe("SQL Injection safety — all values parameterized", () => {
  const pg = new PostgresExpression();

  it("jsonExtract parameterizes every path segment", () => {
    const malicious = "foo'; DROP TABLE users;--";
    const s = pg.jsonExtract('"u"."profile"', [malicious], true);
    expect(s.sql).not.toContain("DROP TABLE");
    expect(s.values).toContain(malicious);
  });

  it("jsonContains parameterizes the candidate JSON", () => {
    const s = pg.jsonContains('"u"."profile"', [], { evil: "'; DROP--" });
    expect(s.sql).not.toContain("DROP");
    expect(s.values).toContain(JSON.stringify({ evil: "'; DROP--" }));
  });

  it("jsonHasKey parameterizes the key", () => {
    const s = pg.jsonHasKey('"u"."profile"', [], "evil' OR '1'='1");
    expect(s.sql).not.toContain("OR '1'");
    expect(s.values).toContain("evil' OR '1'='1");
  });
});
