import { EntityManager } from "@stingerloom/orm";

export type Dialect = "mysql" | "postgres";

export function detectDialect(em: EntityManager): Dialect {
  const driverName = em.getDriver().constructor.name.toLowerCase();
  return driverName.includes("postgres") ? "postgres" : "mysql";
}

/**
 * Quote an identifier for the given dialect. Used for column names that
 * cannot be expressed via the SelectQueryBuilder property→column map
 * (e.g. raw fragments inside a CTE body).
 */
export function q(name: string, dialect: Dialect): string {
  return dialect === "postgres"
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, "``")}\``;
}

/** PostgreSQL `$N` vs MySQL `?` placeholder. */
export function ph(index: number, dialect: Dialect): string {
  return dialect === "postgres" ? `$${index}` : "?";
}

/** Day-truncation expression. */
export function dayOf(column: string, dialect: Dialect): string {
  return dialect === "postgres"
    ? `date_trunc('day', ${column})`
    : `DATE(${column})`;
}

/** Hours between two datetime expressions, dialect-portable. */
export function hoursBetween(
  startCol: string,
  endCol: string,
  dialect: Dialect,
): string {
  return dialect === "postgres"
    ? `EXTRACT(EPOCH FROM (${endCol} - ${startCol})) / 3600.0`
    : `TIMESTAMPDIFF(SECOND, ${startCol}, ${endCol}) / 3600.0`;
}

/** `NOW() - INTERVAL N DAY` — dialect-portable. */
export function nowMinusDays(days: number, dialect: Dialect): string {
  return dialect === "postgres"
    ? `NOW() - INTERVAL '${days} days'`
    : `DATE_SUB(NOW(), INTERVAL ${days} DAY)`;
}

/** Calendar-week truncation expression. */
export function weekOf(column: string, dialect: Dialect): string {
  return dialect === "postgres"
    ? `date_trunc('week', ${column})`
    : `DATE(DATE_SUB(${column}, INTERVAL WEEKDAY(${column}) DAY))`;
}
