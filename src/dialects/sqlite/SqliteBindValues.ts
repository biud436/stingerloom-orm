/* eslint-disable @typescript-eslint/no-explicit-any */
import { InvalidQueryError } from "../../errors/InvalidQueryError";

/**
 * Sanitizes bind values for better-sqlite3, which accepts only
 * number | string | bigint | Buffer | null as a positional parameter:
 *
 * - boolean `true`/`false` → `1`/`0`
 * - Date objects → ISO 8601 string
 * - undefined → null
 * - an array → rejected with `InvalidQueryError`
 *
 * better-sqlite3 spreads an array argument over the positional parameters, so
 * an array bound as one value fills the slots of the values after it, and
 * `[]` removes its own slot. Whether that fails depends on the lengths — with
 * a plain object elsewhere in the list (a named-parameter bag that fills no
 * slot) it can line up and store every value in the wrong column. No
 * positional statement uses an array as one value, so the net rejects every
 * array. Plain objects stay legal: they are how raw queries pass named
 * parameters (`em.query("SELECT :a", [{ a: 1 }])`).
 *
 * Shared by `SqliteConnector` (every query) and
 * `SqliteDriver.queryWithOptions()` (RawPipeline), which bind through their
 * own prepared statements.
 */
export function sanitizeSqliteBindValues(values?: any[]): any[] | undefined {
  if (!values) return values;
  return values.map((v, i) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    if (v === undefined) return null;
    if (Array.isArray(v)) {
      throw new InvalidQueryError(
        `SQLite cannot bind an array as one parameter (bind value #${i + 1}, ${v.length} element${v.length === 1 ? "" : "s"}): ` +
          `better-sqlite3 would spread it over the positional parameters and shift every value after it.`,
        `Serialize the value first (JSON.stringify, or @Column({ type: "json" }) on an entity column), ` +
          `or give an IN list one placeholder per element.`,
      );
    }
    return v;
  });
}
