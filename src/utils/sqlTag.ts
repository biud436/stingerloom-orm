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
