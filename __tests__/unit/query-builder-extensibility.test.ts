/**
 * Tests for #226: SelectQueryBuilder/RawQueryBuilder extensibility (protected fields).
 *
 * Verifies that subclasses can access internal state and helpers.
 */
import sql, { Sql, raw } from "sql-template-tag";
import { RawQueryBuilder, DatabaseType } from "../../src/core/RawQueryBuilder";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";

// ── RawQueryBuilder subclass ──────────────────────────────────────

class CustomRawQueryBuilder extends RawQueryBuilder {
  /** Custom scope: add a WHERE active = true clause. */
  onlyActive(): this {
    const col = this.escapeIdent("active");
    this.sqlQuerySegments.push(sql`${raw(this.hasWhereClause ? "AND" : "WHERE")} ${raw(col)} = ${true}`);
    this.hasWhereClause = true;
    return this;
  }

  /** Expose dbType for assertion. */
  getDbType(): DatabaseType {
    return this.dbType;
  }

  /** Expose CTE count for assertion. */
  getCteCount(): number {
    return this.cteClauses.length;
  }
}

// ── SelectQueryBuilder subclass ───────────────────────────────────

class CustomSelectQueryBuilder<T, TResult = T> extends SelectQueryBuilder<T, TResult> {
  /** Custom scope: add soft-delete-like filter using protected helpers. */
  onlyActive(): this {
    const qualified = this.col("active" as any);
    this.whereClauses.push(sql`${raw(qualified)} = ${true}`);
    return this;
  }

  /** Custom scope: add join using protected addJoin. */
  joinProfile(profileTable: string, alias: string): this {
    const cond = sql`${raw(this.qualifiedCol(this.alias, "id"))} = ${raw(this.qualifiedCol(alias, "userId"))}`;
    this.addJoin("LEFT", profileTable, alias, cond);
    return this;
  }

  /** Expose internal state for assertions. */
  getWhereClauseCount(): number {
    return this.whereClauses.length;
  }

  getJoinClauseCount(): number {
    return this.joinClauses.length;
  }

  getOrderByClauseCount(): number {
    return this.orderByClauses.length;
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("RawQueryBuilder extensibility (#226)", () => {
  it("subclass can access protected fields and helpers", () => {
    const qb = new CustomRawQueryBuilder();
    qb.setDatabaseType("postgresql");
    qb.select(["*"]);
    qb.from("users");
    qb.onlyActive();

    expect(qb.getDbType()).toBe("postgresql");

    const built = qb.build();

    expect(built.sql).toContain("WHERE");
    expect(built.sql).toContain('"active"');
  });

  it("subclass can read cteClauses", () => {
    const qb = new CustomRawQueryBuilder();
    qb.with("cte1", sql`SELECT 1`);
    expect(qb.getCteCount()).toBe(1);
  });

  it("subclass can chain custom + built-in methods", () => {
    const qb = new CustomRawQueryBuilder();
    qb.setDatabaseType("mysql");
    qb.select(["*"]);
    qb.from("users");
    qb.where([sql`age > ${18}`]);
    qb.onlyActive();
    qb.orderBy([{ column: "name", direction: "ASC" }]);
    qb.limit(10);

    const built = qb.build();

    expect(built.sql).toContain("SELECT *");
    expect(built.sql).toContain("FROM users");
    expect(built.sql).toContain("AND");
    expect(built.sql).toContain("`active`");
    expect(built.sql).toContain("ORDER BY");
    expect(built.sql).toContain("LIMIT");
  });
});

describe("SelectQueryBuilder extensibility (#226)", () => {
  // We can't easily construct a real EntityManager in unit tests,
  // but we CAN verify that the class compiles and the protected fields
  // are accessible from a subclass. The type system is the main check.

  it("CustomSelectQueryBuilder class compiles and extends correctly", () => {
    // Verify the subclass prototype chain
    expect(Object.getPrototypeOf(CustomSelectQueryBuilder.prototype)).toBe(
      SelectQueryBuilder.prototype,
    );
    expect(typeof CustomSelectQueryBuilder.prototype.onlyActive).toBe("function");
    expect(typeof CustomSelectQueryBuilder.prototype.joinProfile).toBe("function");
  });

  it("protected fields are enumerable on the prototype", () => {
    // Ensure key protected methods exist on the parent prototype
    const proto = SelectQueryBuilder.prototype as any;
    expect(typeof proto.col).toBe("function");
    expect(typeof proto.qualifiedCol).toBe("function");
    expect(typeof proto.addJoin).toBe("function");
    expect(typeof proto.resolveCondition).toBe("function");
    expect(typeof proto.resolveTableName).toBe("function");
    expect(typeof proto.applyValidation).toBe("function");
    expect(typeof proto.validateRequiredColumns).toBe("function");
  });
});
