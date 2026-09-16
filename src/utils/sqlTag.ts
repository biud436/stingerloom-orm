import sqlDefault, {
  Sql,
  raw,
  join,
  empty,
  type RawValue,
} from "sql-template-tag";

/**
 * Interop-safe access to sql-template-tag for both build outputs.
 *
 * sql-template-tag v4 is a CommonJS package that assigns
 * `exports.default = sql`. The CJS build's `__importDefault` unwraps that
 * correctly, but plain Node ESM sets the default binding to `module.exports`
 * itself — an object whose `.default` holds the tag function. Every module
 * in this codebase therefore imports the tag through this wrapper, which
 * unwraps whichever shape arrives. Do not import "sql-template-tag" directly
 * (guarded by __tests__/unit/sql-template-tag-wrapper.test.ts).
 */
const sqlAny = sqlDefault as unknown;
const sql: typeof sqlDefault =
  typeof sqlAny === "function"
    ? (sqlAny as typeof sqlDefault)
    : (sqlAny as { default: typeof sqlDefault }).default;

export default sql;
export { sql, Sql, raw, join, empty };
export type { RawValue };

/**
 * Structural check for a `sql\`\`` fragment.
 *
 * `instanceof Sql` alone is not enough at the public API boundary: the CJS
 * and ESM builds each resolve their own `sql-template-tag` copy, so a
 * fragment built by one and handed to the other fails the prototype check.
 * The shape is stable across both copies, so it backs up the fast path — but
 * only in the narrow form a real fragment always has, because a value that
 * passes here is spliced into the statement as SQL instead of being bound:
 *
 * - `strings` holds one more entry than `values` (the `Sql` constructor
 *   rejects any other pairing) and every entry is a string;
 * - the value is not a plain object. A fragment carries `Sql.prototype`,
 *   one level below the root of its prototype chain, so a data object that
 *   happens to have `strings` and `values` keys — in this realm or another —
 *   is data and stays data.
 */
export function isSqlFragment(value: unknown): value is Sql {
  if (value === null || typeof value !== "object") return false;
  if (value instanceof Sql) return true;
  const { strings, values } = value as { strings?: unknown; values?: unknown };
  if (!Array.isArray(strings) || !Array.isArray(values)) return false;
  if (strings.length !== values.length + 1) return false;
  if (!strings.every((part) => typeof part === "string")) return false;
  const proto: object | null = Object.getPrototypeOf(value);
  return proto !== null && Object.getPrototypeOf(proto) !== null;
}
