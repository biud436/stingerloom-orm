/* eslint-disable @typescript-eslint/no-explicit-any */
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { FILTER_OPERATOR_KEYS, LockMode } from "../dialects/FindOption";
import { closestIdentifier } from "../utils/closestIdentifier";
import {
  isBoolean,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isObjectOf,
  isOneOf,
  isString,
  showValue,
  type ObjectShape,
  type OptionRule,
} from "../utils/optionRules";

/**
 * Shape checks for the options of a read, run once when the read is called.
 *
 * TypeScript already rejects these shapes in an object literal; they reach
 * the ORM from options built at runtime (a query string, a JSON body, a
 * spread DTO). Before, each one failed far from its cause — `take: "10"` and
 * `limit: [0]` as a driver datatype error, `orderBy: "title"` as "Invalid
 * ORDER BY direction: t", a typo'd option key not at all.
 *
 * @internal Package-internal — not a public API.
 */

/** Which read the options belong to: each takes a different key set. */
export type ReadOptionKind = "find" | "cursor" | "page";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Validated where it is resolved (`RelationTree`, `RelationCount`). */
const checkedElsewhere: OptionRule = () => {};

const isWhereObjectOrArray: OptionRule = (value, path, problems) => {
  if (typeof value !== "object" || value === null) {
    problems.push(`'${path}' must be an object or an array of objects, got ${showValue(value)}.`);
  }
};

const isWhereObject: OptionRule = (value, path, problems) => {
  if (Array.isArray(value)) {
    problems.push(
      `'${path}' must be one where object, got an array. Join alternatives with OR: [{ ... }, { ... }] inside it.`,
    );
  } else if (typeof value !== "object" || value === null) {
    problems.push(`'${path}' must be an object, got ${showValue(value)}.`);
  }
};

/** `"ASC"` / `"DESC"` in either case — the builders upper-case it. */
function isDirection(value: unknown): boolean {
  return typeof value === "string" && (value.toUpperCase() === "ASC" || value.toUpperCase() === "DESC");
}

const isOrderByObject: OptionRule = (value, path, problems) => {
  if (!isPlainObject(value)) {
    problems.push(
      `'${path}' must be an object keyed by property, such as { createdAt: "DESC" }, got ${showValue(value)}.`,
    );
    return;
  }
  for (const [key, direction] of Object.entries(value)) {
    // A falsy direction leaves the property out of ORDER BY.
    if (!direction) continue;
    if (!isDirection(direction)) {
      problems.push(`'${path}.${key}' must be "ASC" or "DESC", got ${showValue(direction)}.`);
    }
  }
};

const isCursorOrderBy: OptionRule = (value, path, problems) => {
  if (typeof value === "string" && value.length > 0) return;
  if (isPlainObject(value)) {
    const [key, direction] = Object.entries(value)[0] ?? [];
    const example = key
      ? `orderBy: ${showValue(key)}${isDirection(direction) ? `, direction: ${showValue(String(direction).toUpperCase())}` : ""}`
      : `orderBy: "createdAt", direction: "DESC"`;
    problems.push(
      `'${path}' names one property to sort by, got an object. findWithCursor() pages by a single column: write ${example}.`,
    );
    return;
  }
  problems.push(`'${path}' must be a property name, got ${showValue(value)}.`);
};

const isDirectionRule: OptionRule = (value, path, problems) => {
  if (!isDirection(value)) {
    problems.push(`'${path}' must be "ASC" or "DESC", got ${showValue(value)}.`);
  }
};

const isSelect: OptionRule = (value, path, problems) => {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (typeof item !== "string") {
        problems.push(`'${path}[${i}]' must be a property name, got ${showValue(item)}.`);
      }
    });
    return;
  }
  if (!isPlainObject(value)) {
    problems.push(
      `'${path}' must be an array of property names or an object keyed by property, got ${showValue(value)}.`,
    );
  }
};

const isGroupBy: OptionRule = (value, path, problems) => {
  if (!Array.isArray(value)) {
    problems.push(`'${path}' must be an array of property names, got ${showValue(value)}.`);
    return;
  }
  value.forEach((item, i) => {
    if (typeof item !== "string") {
      problems.push(`'${path}[${i}]' must be a property name, got ${showValue(item)}.`);
    }
  });
};

const isSqlArray: OptionRule = (value, path, problems) => {
  if (!Array.isArray(value)) {
    problems.push(`'${path}' must be an array of sql\`...\` conditions, got ${showValue(value)}.`);
  }
};

/** A count or a `[offset, count]` tuple. */
const isLimit: OptionRule = (value, path, problems) => {
  if (Array.isArray(value)) {
    if (value.length !== 2) {
      problems.push(`'${path}' must be a count or an [offset, count] pair, got an array of ${value.length}.`);
      return;
    }
    isNonNegativeInteger(value[0], `${path}[0]`, problems);
    isNonNegativeInteger(value[1], `${path}[1]`, problems);
    return;
  }
  isNonNegativeInteger(value, path, problems);
};

/** Any integer: `findWithCursor` falls back to the default page size below 1. */
const isPageSize: OptionRule = (value, path, problems) => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    problems.push(`'${path}' must be an integer, got ${showValue(value)}.`);
  }
};

/** Any finite number: `findWithPage` floors it and treats values below 1 as page 1. */
const isPage: OptionRule = (value, path, problems) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    problems.push(`'${path}' must be a number, got ${showValue(value)}.`);
  }
};

const isCacheOption: OptionRule = (value, path, problems) => {
  if (typeof value === "boolean") return;
  if (typeof value === "number") {
    isNonNegativeNumber(value, path, problems);
    return;
  }
  if (isPlainObject(value)) {
    isObjectOf({ ttl: isNonNegativeNumber, tag: isString })(value, path, problems);
    return;
  }
  problems.push(`'${path}' must be true, a TTL in milliseconds or { ttl, tag }, got ${showValue(value)}.`);
};

const isCursor: OptionRule = (value, path, problems) => {
  if (typeof value !== "string") {
    problems.push(`'${path}' must be the nextCursor string of a previous page, got ${showValue(value)}.`);
  }
};

const SHARED_RULES: ObjectShape = {
  where: isWhereObjectOrArray,
  select: isSelect,
  orderBy: isOrderByObject,
  relations: checkedElsewhere,
  withCount: checkedElsewhere,
  withDeleted: isBoolean,
  timeout: isNonNegativeNumber,
  useMaster: isBoolean,
  groupBy: isGroupBy,
  having: isSqlArray,
  cache: isCacheOption,
};

const OPTION_RULES: Record<ReadOptionKind, ObjectShape> = {
  find: {
    ...SHARED_RULES,
    limit: isLimit,
    skip: isNonNegativeInteger,
    take: isNonNegativeInteger,
    onlyDeleted: isBoolean,
    lock: isOneOf(Object.values(LockMode)),
    distinct: isBoolean,
    withoutTenantScope: isBoolean,
  },
  cursor: {
    where: isWhereObject,
    take: isPageSize,
    cursor: isCursor,
    orderBy: isCursorOrderBy,
    direction: isDirectionRule,
    relations: checkedElsewhere,
    withCount: checkedElsewhere,
    withDeleted: isBoolean,
    useMaster: isBoolean,
    timeout: isNonNegativeNumber,
    withoutTenantScope: isBoolean,
    cache: isCacheOption,
  },
  page: {
    ...SHARED_RULES,
    page: isPage,
    pageSize: isPageSize,
  },
};

/**
 * Rejects options a read cannot run as written — every problem listed in
 * one `InvalidQueryError`.
 *
 * A key set to `undefined` or `null` counts as not set. `where`, `relations`
 * and `withCount` are only checked for their outer shape here; their
 * contents are checked against the entity where they are resolved.
 *
 * @param method The public method, named in the message: `find`, `findOne`.
 * @param required True for reads whose options argument is not optional.
 */
export function validateReadOptionShape(
  option: unknown,
  method: string,
  entityName: string,
  kind: ReadOptionKind = "find",
  required = false,
): void {
  if (option === undefined && !required) return;
  if (typeof option !== "object" || option === null || Array.isArray(option)) {
    const example =
      kind === "find"
        ? `${method}(${entityName}, { where: { id: 1 } })`
        : `${method}(${entityName}, { ${kind === "cursor" ? "take: 20" : "page: 1, pageSize: 20"} })`;
    throw new InvalidQueryError(
      `${method}() for entity "${entityName}" takes an options object, got ${showValue(option)}.`,
      `Write ${example}.`,
    );
  }

  const rules = OPTION_RULES[kind];
  const problems: string[] = [];
  let unknownKey = false;
  for (const [key, value] of Object.entries(option)) {
    const rule = rules[key];
    if (!rule) {
      if (value === undefined) continue;
      unknownKey = true;
      const suggestion = closestIdentifier(key, Object.keys(rules));
      problems.push(`Unknown option '${key}'.` + (suggestion ? ` Did you mean '${suggestion}'?` : ""));
      continue;
    }
    if (value === undefined || value === null) continue;
    rule(value, key, problems);
  }

  if (problems.length > 0) {
    throw new InvalidQueryError(
      `Invalid options passed to ${method}() for entity "${entityName}":\n  - ${problems.join("\n  - ")}`,
      unknownKey
        ? `${method}() takes: ${Object.keys(rules).join(", ")}.`
        : "Values read from a query string arrive as strings: convert them before passing them on.",
    );
  }
}

/**
 * The where a filter-first read (`findBy`, `findOneBy`, `pluck`) takes as
 * its argument must be an object or an array of them. A bare value read no
 * column: `findOneBy(User, 1)` returned an arbitrary row.
 */
export function assertWhereArgument(where: unknown, method: string, entityName: string): void {
  if (where === undefined || where === null || typeof where === "object") return;
  throw new InvalidQueryError(
    `${method}() for entity "${entityName}" takes a where object or an array of them, got ${showValue(where)}.`,
    `Name the columns to match, e.g. ${method}(${entityName}, { id: 1 }); findByPK(${entityName}, id) reads by primary key.`,
  );
}

// ── where operands ──────────────────────────────────────────

const OPERATORS = [...FILTER_OPERATOR_KEYS];

const PATTERN_OPERATORS: ReadonlySet<string> = new Set([
  "like",
  "notLike",
  "ilike",
  "contains",
  "startsWith",
  "endsWith",
  "search",
]);

const SINGLE_VALUE_OPERATORS: ReadonlySet<string> = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);

/** Names the where (or criteria) a problem is in, for the message. */
export interface WhereShapeSite {
  /** `where` for reads, `criteria` for delete / softDelete / restore. */
  readonly clause: string;
  readonly entityName: string;
}

function whereShapeError(site: WhereShapeSite, problem: string, hint: string): InvalidQueryError {
  return new InvalidQueryError(`Invalid ${site.clause} for entity "${site.entityName}": ${problem}`, hint);
}

const OPERATOR_HINT = `Operators: ${OPERATORS.join(", ")}.`;

/** A where (or one element of its array form) must be an object. */
export function assertWhereObject(value: unknown, path: string, site: WhereShapeSite): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return;
  const several =
    site.clause === "criteria"
      ? " deleteMany(Entity, ids) deletes rows by primary key."
      : "";
  throw whereShapeError(
    site,
    path === site.clause
      ? `expected an object or an array of objects, got ${showValue(value)}.`
      : `${path} must be an object, got ${showValue(value)}.`,
    `Name the columns to match, e.g. { id: 1 }; match several values with { id: { in: [1, 2] } }.${several}`,
  );
}

/** `OR` / `AND` take an array of where objects, `NOT` takes one. */
export function assertCombinatorShape(
  key: "OR" | "AND" | "NOT",
  value: unknown,
  path: string,
  site: WhereShapeSite,
): void {
  if (key === "NOT") {
    if (Array.isArray(value)) {
      throw whereShapeError(
        site,
        `${path} takes one where object, got an array.`,
        "To negate several conditions at once, NOT: { OR: [...] } matches the rows that meet none of them.",
      );
    }
    assertWhereObject(value, path, site);
    return;
  }
  if (!Array.isArray(value)) {
    throw whereShapeError(
      site,
      `${path} takes an array of where objects, got ${showValue(value)}.`,
      `Write ${key}: [{ ... }, { ... }].`,
    );
  }
  value.forEach((entry, i) => assertWhereObject(entry, `${path}[${i}]`, site));
}

/**
 * Checks the value of one where field that is a plain object: an operator
 * object (`{ gt: 18 }`) whose operators exist and take the operand given.
 *
 * `literal` is true for a column whose values may themselves be plain
 * objects — a `json` / `jsonb` / custom-type column or one with a
 * transformer. There an object with a key that is no operator is a value to
 * compare with, so only an object made of operators is checked.
 */
export function assertFilterObject(
  field: string,
  filter: Record<string, unknown>,
  literal: boolean,
  path: string,
  site: WhereShapeSite,
): void {
  const keys = Object.keys(filter);
  const unknown = keys.filter((k) => !FILTER_OPERATOR_KEYS.has(k));
  if (unknown.length > 0) {
    // The resolver compares such an object as a value, as it always has.
    if (literal) return;
    const suggestion = closestIdentifier(unknown[0], OPERATORS);
    throw whereShapeError(
      site,
      `unknown operator "${unknown[0]}" on "${field}" (${path}).` +
        (suggestion ? ` Did you mean "${suggestion}"?` : ""),
      OPERATOR_HINT,
    );
  }
  if (keys.length === 0) {
    if (literal) return;
    throw whereShapeError(
      site,
      `"${field}" (${path}) is an empty object.`,
      "Give it an operator, e.g. { eq: value }, or leave the field out.",
    );
  }

  for (const op of keys) {
    const operand = filter[op];
    // The resolver names an undefined operand itself.
    if (operand === undefined) continue;
    assertOperand(field, op, operand, literal, `${path}.${op}`, site);
  }
}

function assertOperand(
  field: string,
  op: string,
  operand: unknown,
  literal: boolean,
  path: string,
  site: WhereShapeSite,
): void {
  const fail = (needs: string, hint: string): never => {
    throw whereShapeError(
      site,
      `operator "${op}" on "${field}" (${path}) needs ${needs}, got ${describeOperand(operand)}.`,
      hint,
    );
  };

  if (op === "in" || op === "notIn") {
    if (!Array.isArray(operand)) {
      fail("an array", `Write { ${op}: [${showValue(operand)}] }, or { ${op === "in" ? "eq" : "ne"}: ${showValue(operand)} } for a single value.`);
    }
    return;
  }
  if (op === "between") {
    if (!Array.isArray(operand) || operand.length !== 2) {
      fail("[min, max]", "Use gte / lte for a range that is open on one side.");
    }
    return;
  }
  if (PATTERN_OPERATORS.has(op)) {
    if (typeof operand !== "string") {
      fail("a string", op === "search" ? "Pass the search text as a string." : "Pattern operators match text; pass the value as a string.");
    }
    return;
  }
  if (op === "isNull") {
    if (typeof operand !== "boolean") {
      fail("true or false", "isNull: true matches NULL, isNull: false matches every other value.");
    }
    return;
  }
  if (literal) return;
  if (op === "not") {
    if (Array.isArray(operand)) {
      fail("one value or an operator object", `Use notIn: [...] to exclude several values.`);
    }
    if (isPlainObject(operand)) assertFilterObject(field, operand, literal, path, site);
    return;
  }
  if (SINGLE_VALUE_OPERATORS.has(op)) {
    if (Array.isArray(operand)) {
      fail(
        "a single value",
        op === "eq" || op === "ne"
          ? `Use ${op === "eq" ? "in" : "notIn"}: [...] to compare with several values.`
          : "Compare with one value; use between: [min, max] for a range.",
      );
    }
    if (isPlainObject(operand)) {
      fail("a single value", "Operators do not nest, except under not.");
    }
  }
}

function describeOperand(value: unknown): string {
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (isPlainObject(value)) return "an object";
  return showValue(value);
}

export { isPlainObject };
