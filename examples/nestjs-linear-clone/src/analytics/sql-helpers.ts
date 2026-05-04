import { EntityManager, raw } from "@stingerloom/orm";
import sql, { Sql } from "sql-template-tag";

export type Dialect = "mysql" | "postgres";

export function detectDialect(em: EntityManager): Dialect {
  return em.getDriver().isMySqlFamily() ? "mysql" : "postgres";
}

/**
 * Quote an identifier as a plain string. Used at boundaries that take
 * `string` (e.g. `RawQueryBuilder.orderBy({ column })`) or for static
 * SQL fragments built outside a `sql\`\`` template.
 */
export function q(name: string, dialect: Dialect): string {
  return dialect === "postgres"
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, "``")}\``;
}

/** Dialect-bound identifier interpolator for `sql\`\`` templates. */
export function quoter(dialect: Dialect): (name: string) => Sql {
  return (name: string) => raw(q(name, dialect));
}

/** PostgreSQL `$N` vs MySQL `?` placeholder. */
export function ph(index: number, dialect: Dialect): string {
  return dialect === "postgres" ? `$${index}` : "?";
}

/**
 * Aliased table reference. Property access resolves to a qualified
 * column ref (e.g. `r.id` → `` r.`id` ``); call `.as(col, asName?)` to
 * project with an `AS alias` clause.
 */
export type TableRef = Record<string, Sql> & {
  as(col: string, asName?: string): Sql;
};

const RESERVED_TBL_PROPS = new Set([
  "as",
  "then",
  "constructor",
  "toJSON",
  "toString",
  "valueOf",
]);

function makeTableRef(alias: string, Q: (name: string) => Sql): TableRef {
  return new Proxy({} as TableRef, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "as") {
        return (col: string, asName?: string) =>
          sql`${raw(alias)}.${Q(col)} AS ${Q(asName ?? col)}`;
      }
      if (RESERVED_TBL_PROPS.has(prop)) return undefined;
      return sql`${raw(alias)}.${Q(prop)}`;
    },
  });
}

/**
 * Bundle of dialect-bound helpers for one query. Created once per
 * method via `dsl(detectDialect(em))` so that every helper inside the
 * query body is dialect-free at the call site.
 */
export function dsl(dialect: Dialect) {
  const Q = quoter(dialect);

  const dayOf = (column: Sql): Sql =>
    dialect === "postgres"
      ? sql`date_trunc('day', ${column})`
      : sql`DATE(${column})`;

  const weekOf = (column: Sql): Sql =>
    dialect === "postgres"
      ? sql`date_trunc('week', ${column})`
      : sql`DATE(DATE_SUB(${column}, INTERVAL WEEKDAY(${column}) DAY))`;

  const hoursBetween = (startCol: Sql, endCol: Sql): Sql =>
    dialect === "postgres"
      ? sql`EXTRACT(EPOCH FROM (${endCol} - ${startCol})) / 3600.0`
      : sql`TIMESTAMPDIFF(SECOND, ${startCol}, ${endCol}) / 3600.0`;

  const nowMinusDays = (days: number): Sql =>
    dialect === "postgres"
      ? sql`NOW() - (${days} * INTERVAL '1 day')`
      : sql`DATE_SUB(NOW(), INTERVAL ${days} DAY)`;

  return {
    dialect,
    Q,
    q: (name: string) => q(name, dialect),
    tbl: (alias: string): TableRef => makeTableRef(alias, Q),
    dayOf,
    weekOf,
    hoursBetween,
    nowMinusDays,
  };
}
