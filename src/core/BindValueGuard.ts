/**
 * Guards the values the write paths bind for one column.
 *
 * No driver binds a JS array or a plain object as one scalar parameter, and
 * each one fails differently: better-sqlite3 spreads an array over the
 * positional slots and reads a plain object as a named-parameter bag, mysql2
 * expands an array into a value list and renders an object as
 * `'[object Object]'`, pg sends an array literal or JSON text. Depending on
 * the value, that shifts the values after it into the wrong columns without
 * an error. The check runs on the value the column's write transforms
 * produced, right before it is bound.
 *
 * @internal Package-internal — not a public API.
 */
import { isSqlFragment } from "../utils/sqlTag";
import { isPlaceholder } from "./CompiledQuery";
import { ColumnTypeRegistry, type DialectName } from "./ColumnTypeRegistry";
import { isJsonColumnType } from "./JsonColumnTransformer";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import type { ColumnMetadata } from "../scanner/ColumnScanner";

/** The shape of a value no driver binds as one scalar parameter. */
export type NonScalarKind = "array" | "object";

/**
 * Classifies a bind value: `"array"`, `"object"`, or `null` for a value the
 * drivers bind as one parameter.
 *
 * `null` (exempt): primitives (bigint included), `Date`, `Buffer` and other
 * ArrayBuffer views, `sql` fragments, prepared-query placeholders, and class
 * instances that tell drivers how to serialize themselves (`toJSON`,
 * `toPostgres`, `toSqlString`, `Symbol.toPrimitive`, or their own
 * `toString`) — Decimal, Luxon, Temporal and the like.
 *
 * `"object"`: a plain or null-prototype object, `Map`/`Set`, and any other
 * class instance — a nested DTO renders as `'[object Object]'` on MySQL. A
 * plain object that merely carries `strings` and `values` keys is data, not a
 * fragment: {@link isSqlFragment} takes the prototype into account, so such a
 * value is classified here instead of being spliced into the statement.
 */
export function classifyBindValue(value: unknown): NonScalarKind | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) return "array";
  if (value instanceof Date || ArrayBuffer.isView(value)) return null;
  if (isSqlFragment(value) || isPlaceholder(value)) return null;

  // A plain object's prototype is the root of its chain. Comparing against the
  // root instead of this realm's Object.prototype also covers values built in
  // another realm (a vm context, a test sandbox).
  const proto: object | null = Object.getPrototypeOf(value);
  if (proto === null || Object.getPrototypeOf(proto) === null) return "object";

  const candidate = value as {
    toJSON?: unknown;
    toPostgres?: unknown;
    toSqlString?: unknown;
    toString?: unknown;
    [Symbol.toPrimitive]?: unknown;
  };
  if (
    typeof candidate.toJSON === "function" ||
    typeof candidate.toPostgres === "function" ||
    typeof candidate.toSqlString === "function" ||
    typeof candidate[Symbol.toPrimitive] === "function" ||
    candidate.toString !== rootToString(proto)
  ) {
    return null;
  }
  return "object";
}

/** The `toString` of the object at the root of a prototype chain. */
function rootToString(proto: object): unknown {
  let root = proto;
  let next = Object.getPrototypeOf(root);
  while (next !== null) {
    root = next;
    next = Object.getPrototypeOf(root);
  }
  return (root as { toString?: unknown }).toString;
}

/**
 * Throws `InvalidQueryError` when `value` — already through the column's write
 * transforms — cannot be bound to `column` as one parameter.
 *
 * A non-scalar value is accepted only where the PostgreSQL driver serializes
 * it into what the column stores:
 *
 * | Column                    | Accepted non-scalar | Dialect    |
 * |---------------------------|---------------------|------------|
 * | `json` / `jsonb`          | object              | PostgreSQL |
 * | `array`                   | array               | PostgreSQL |
 * | `ColumnTypeRegistry` type | any (unchecked)     | PostgreSQL |
 *
 * The dialect is resolved only once a non-scalar value is found, so a scalar
 * costs one `typeof` check and an EntityManager with no connection never
 * reaches the lookup.
 *
 * @param site - The operation that produced the value (`"save()"`,
 *   `"updateMany()"`), named in the message so the caller does not have to
 *   read the stack trace.
 */
export function assertColumnBindValue(
  column: ColumnMetadata,
  value: unknown,
  dialect: () => DialectName,
  site?: string,
): void {
  if (value === null || typeof value !== "object") return;
  const kind = classifyBindValue(value);
  if (kind === null) return;

  const type = column.options?.type;
  const resolved = dialect();
  if (resolved === "postgres") {
    if (kind === "object" && isJsonColumnType(type)) return;
    if (kind === "array" && type === "array") return;
    if (type && ColumnTypeRegistry.getInstance().has(type)) return;
  }

  const typeName = String(type ?? "untyped");
  const transformed =
    !!column.transformer?.to ||
    (!!type && !!ColumnTypeRegistry.getInstance().getTransformer(type)?.to);
  const received = receivedPhrase(kind, transformed, site);
  const subject =
    `${describeColumn(column)} is ${typeArticle(typeName)} "${typeName}" column`;

  if (isJsonColumnType(type) || type === "array") {
    throw new InvalidQueryError(
      `${subject} but ${received}; ${structuredConsequence(kind, resolved, type === "array")}`,
      transformed
        ? "Return the serialized JSON string from transformer.to(), or remove to() to use the built-in JSON serialization."
        : "Pass an array to an array column, or declare the column as json / jsonb for object values.",
    );
  }

  throw new InvalidQueryError(
    `${subject} but ${received}, which cannot be bound as one value: ` +
      `${scalarConsequence(kind, resolved, value)}.`,
    `Declare @Column({ type: "json" }) for structured values (type: "array" keeps a native array on PostgreSQL), ` +
      `or give the column a transformer whose to() returns a string or a number.`,
  );
}

/**
 * The scalar-only check for a value bound under a key that has no column
 * metadata — a `@ManyToOne` FK shadow property (`ownerId`) in an update
 * payload.
 */
export function assertScalarBindValue(
  entityName: string,
  key: string,
  value: unknown,
  dialect: () => DialectName,
  site?: string,
): void {
  if (value === null || typeof value !== "object") return;
  const kind = classifyBindValue(value);
  if (kind === null) return;
  const subject = site ? `${entityName}.${key}: ${site}` : `${entityName}.${key}`;
  throw new InvalidQueryError(
    `${subject} received ${article(kind)}, which cannot be bound as one value: ` +
      `${scalarConsequence(kind, dialect(), value)}.`,
    "Pass the key value itself (a number or a string) for a foreign key column.",
  );
}

/**
 * "save() received an array" / "received an array" — the operation is named
 * whenever the call site passed one.
 */
function receivedPhrase(
  kind: NonScalarKind,
  transformed: boolean,
  site: string | undefined,
): string {
  if (transformed) {
    return site
      ? `${site} bound what its write transformer returned, ${article(kind)}`
      : `its write transformer returned ${article(kind)}`;
  }
  return site
    ? `${site} received ${article(kind)}`
    : `received ${article(kind)}`;
}

function describeColumn(column: ColumnMetadata): string {
  const target = column.target as { constructor?: { name?: string } } | undefined;
  const entityName = target?.constructor?.name || "Entity";
  return `${entityName}.${column.propertyKey ?? column.name}`;
}

function article(kind: NonScalarKind): string {
  return kind === "array" ? "an array" : "an object";
}

/** "a" / "an" for a quoted column type name ("an int", "an enum", "a uuid"). */
function typeArticle(typeName: string): string {
  return /^[aeio]/i.test(typeName) ? "an" : "a";
}

function scalarConsequence(
  kind: NonScalarKind,
  dialect: DialectName,
  value: object,
): string {
  if (kind === "array") {
    const n = (value as unknown[]).length;
    const values = `${n} value${n === 1 ? "" : "s"}`;
    switch (dialect) {
      case "postgres":
        return 'pg would send it as an array literal such as {"a","b"}';
      case "mysql":
        return `mysql2 would expand it into a list of ${values}`;
      default:
        return `better-sqlite3 would spread it over ${values} and shift every value after it`;
    }
  }
  switch (dialect) {
    case "postgres":
      return "pg would send its JSON text";
    case "mysql":
      return 'mysql2 would send "[object Object]"';
    default:
      return "better-sqlite3 would read it as a named-parameter bag and bind nothing for this column";
  }
}

function structuredConsequence(
  kind: NonScalarKind,
  dialect: DialectName,
  arrayColumn: boolean,
): string {
  if (dialect !== "postgres") {
    const name = dialect === "mysql" ? "MySQL" : "SQLite";
    return `${name} stores this column as JSON text, so the value has to be serialized before it is bound.`;
  }
  if (arrayColumn) {
    return "PostgreSQL binds only an array to an array column.";
  }
  return kind === "array"
    ? "pg would send it as an array literal, which is not valid JSON."
    : "PostgreSQL cannot bind this value to the column.";
}
