import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import {
  ROW_SHAPE_FIELDS,
  type RowShape,
} from "../schema/defineRow";
import { type ColumnRead, resolveColumnRead } from "./ColumnReadTransform";
import { isUnsafeInteger } from "./BigintColumnTransformer";

interface PlannedField {
  key: string;
  column: string;
  read: ColumnRead | undefined;
}

interface RowReadPlan {
  fields: PlannedField[];
  /**
   * Names excluded from the pass-through copy: the result columns a field
   * reads, and the field keys themselves (an undeclared column named like a
   * field key must not overwrite that field).
   */
  reserved: Set<string>;
}

/** Built on first use per shape; a shape never queried never gets a plan. */
const planCache = new WeakMap<object, RowReadPlan>();

const NUMERIC_TYPES = new Set(["int", "float", "double", "number"]);

/**
 * Raw-result numeric read. An entity column of these types always reaches
 * the ORM as a JS number, but a raw query can return the same declared type
 * from an expression the driver hands over as a string — PostgreSQL
 * `NUMERIC` / `COUNT(*)` (int8), mysql2 `DECIMAL` / `SUM()`. Numeric strings
 * become numbers; an integer a JS number cannot hold exactly throws instead
 * of rounding. Non-numeric values pass through, like the other read
 * conversions do with input they cannot interpret.
 */
function makeNumericRead(owner: string, key: string): ColumnRead {
  return (raw) => {
    if (typeof raw === "number") return raw;
    if (typeof raw !== "bigint" && typeof raw !== "string") return raw;
    if (isUnsafeInteger(raw)) {
      throw new OrmError(
        OrmErrorCode.BIGINT_PRECISION_LOSS,
        `${owner}.${key} holds ${String(raw)}, which cannot be represented ` +
          `exactly as a JS number (outside ±2^53).`,
        `Declare the field as t.bigint({ mode: "string" }) or ` +
          `t.bigint({ mode: "bigint" }) to read it losslessly.`,
      );
    }
    if (typeof raw === "bigint") return Number(raw);
    if (raw.trim() === "") return raw;
    const asNumber = Number(raw);
    return Number.isFinite(asNumber) ? asNumber : raw;
  };
}

function compilePlan(shape: RowShape<unknown>): RowReadPlan {
  const fields: PlannedField[] = [];
  const reserved = new Set<string>();
  for (const field of shape[ROW_SHAPE_FIELDS]) {
    const read =
      resolveColumnRead(field.spec, shape.name, field.key) ??
      (field.spec.type && NUMERIC_TYPES.has(field.spec.type)
        ? makeNumericRead(shape.name, field.key)
        : undefined);
    fields.push({ key: field.key, column: field.column, read });
    reserved.add(field.column);
    reserved.add(field.key);
  }
  return { fields, reserved };
}

function planFor(shape: RowShape<unknown>): RowReadPlan {
  let plan = planCache.get(shape);
  if (!plan) {
    plan = compilePlan(shape);
    planCache.set(shape, plan);
  }
  return plan;
}

function missingColumnError(
  shape: RowShape<unknown>,
  plan: RowReadPlan,
  row: Record<string, unknown>,
): OrmError | undefined {
  const missing = plan.fields.filter((f) => !(f.column in row));
  if (missing.length === 0) return undefined;

  const resultColumns = Object.keys(row);
  const lowerToActual = new Map(
    resultColumns.map((c) => [c.toLowerCase(), c] as const),
  );
  const folded = missing
    .map((f) => [f, lowerToActual.get(f.column.toLowerCase())] as const)
    .filter(([, actual]) => actual !== undefined);

  const list = missing
    .map((f) =>
      f.column === f.key
        ? `"${f.column}"`
        : `"${f.column}" (field "${f.key}")`,
    )
    .join(", ");
  let hint =
    "Select each declared column (alias an expression with AS), or point " +
    'the field at the column the query returns with .name("…").';
  if (folded.length > 0) {
    const [field, actual] = folded[0];
    hint +=
      ` The result has "${actual}" — PostgreSQL folds unquoted identifiers ` +
      `to lower case; quote the alias ("${field.column}") or use ` +
      `.name("${actual}").`;
  }
  return new OrmError(
    OrmErrorCode.QUERY_ERROR,
    `em.query(${shape.name}): the result has no column ${list}. ` +
      `Result columns: ${resultColumns.join(", ") || "(none)"}.`,
    hint,
  );
}

/**
 * Applies a {@link RowShape} to raw driver rows: declared columns are read
 * into their property keys and converted per their type (NULL stays NULL),
 * undeclared columns are copied through untouched. The input rows are not
 * mutated.
 *
 * Throws when a declared column is missing from the result, so the inferred
 * row type never claims a property the query did not return.
 */
export function readRowsWithShape<Row>(
  shape: RowShape<Row>,
  rows: Record<string, unknown>[],
): Row[] {
  if (rows.length === 0) return [];
  const plan = planFor(shape as RowShape<unknown>);

  const missing = missingColumnError(shape as RowShape<unknown>, plan, rows[0]);
  if (missing) throw missing;

  const { fields, reserved } = plan;
  const out = new Array<Row>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const shaped: Record<string, unknown> = {};
    for (const field of fields) {
      const value = row[field.column];
      shaped[field.key] =
        field.read && value !== null && value !== undefined
          ? field.read(value)
          : value;
    }
    for (const column in row) {
      if (!reserved.has(column)) shaped[column] = row[column];
    }
    out[i] = shaped as Row;
  }
  return out;
}
