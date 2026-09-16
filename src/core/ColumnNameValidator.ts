/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ColumnMetadata } from "../scanner/ColumnScanner";
import type { ClazzType } from "../utils/types";
import type { InheritanceResolver } from "./InheritanceResolver";
import { InvalidQueryError } from "../errors";
import { closestIdentifier } from "../utils/closestIdentifier";

/**
 * Clause a rejected identifier came from, used verbatim in the message.
 *
 * `criteria` is the second argument of delete / softDelete / restore, `data`
 * the SET payload of updateMany; `where` covers reads and updateMany's
 * `options.where`.
 */
export type IdentifierClause =
  | "where"
  | "orderBy"
  | "select"
  | "groupBy"
  | "criteria"
  | "data";

/**
 * The identifiers a read query may name for one entity, plus the entity name
 * for error messages.
 */
export interface ColumnNameScope {
  entityName: string;
  valid: Set<string>;
}

/**
 * Keys `resolveWhereClause` interprets as logical combinators rather than
 * column references.
 */
const LOGICAL_KEYS = new Set(["AND", "OR", "NOT"]);

/**
 * Builds the accepted identifier set for a read query.
 *
 * Deliberately permissive: it is the union of everything the SQL builders can
 * resolve *or* pass through verbatim, because `where` / `orderBy` / `select`
 * fall back to the raw key when it is not in the property map. Measured
 * fallback users that must keep working:
 *
 * - DB column names typed directly (`where: { created_at: ... }` under a
 *   NamingStrategy) — covered by the property map's values.
 * - `@ManyToOne` / `@OneToOne` FK shadow properties (`userId`) — covered by
 *   the property map's keys.
 * - Columns of a sibling/child class in a single-table hierarchy, filtered
 *   from the root query, and the discriminator column itself.
 * - `@ComputedColumn` properties, which are generated columns in the table but
 *   are not part of `metadata.columns`.
 */
export function buildColumnNameScope(params: {
  entityName: string;
  columns: ColumnMetadata[];
  propertyToColumn: Map<string, string>;
  computedColumns?: Iterable<string> | null;
  hierarchyColumns?: ColumnMetadata[] | null;
  discriminatorColumn?: string | null;
}): ColumnNameScope {
  const valid = new Set<string>();

  const addColumn = (col: ColumnMetadata | undefined) => {
    if (!col) return;
    if (col.propertyKey) valid.add(col.propertyKey);
    if (col.name) valid.add(col.name);
  };

  for (const col of params.columns) addColumn(col);
  for (const col of params.hierarchyColumns ?? []) addColumn(col);
  for (const [prop, col] of params.propertyToColumn) {
    valid.add(prop);
    if (col) valid.add(col);
  }
  for (const name of params.computedColumns ?? []) valid.add(name);
  if (params.discriminatorColumn) valid.add(params.discriminatorColumn);

  return { entityName: params.entityName, valid };
}

export function assertKnownColumn(
  name: string,
  clause: IdentifierClause,
  scope: ColumnNameScope,
): void {
  if (scope.valid.has(name)) return;

  const suggestion = closestIdentifier(name, scope.valid);
  throw new InvalidQueryError(
    `Unknown column "${name}" in "${clause}" for entity "${scope.entityName}".` +
      (suggestion ? ` Did you mean "${suggestion}"?` : ""),
    `Valid columns: ${[...scope.valid].join(", ")}`,
  );
}

/**
 * Walks a `where` clause the same way `resolveWhereClause` does — array form
 * is OR-ed, `AND` / `OR` take clause arrays, `NOT` takes a single clause — and
 * checks every column key it would emit.
 *
 * `undefined` values are skipped because the resolver skips them too, and a
 * function value is a hook method rather than a filter. Shared by the read
 * paths and the criteria-based writes (delete / updateMany / softDelete /
 * restore), which run their criteria through the same resolver — `clause`
 * only changes the wording of the error.
 */
export function validateWhereIdentifiers(
  where: unknown,
  scope: ColumnNameScope,
  clause: IdentifierClause = "where",
): void {
  if (where === undefined || where === null) return;

  if (Array.isArray(where)) {
    for (const entry of where) validateWhereIdentifiers(entry, scope, clause);
    return;
  }
  if (typeof where !== "object") return;

  for (const key of Object.keys(where as Record<string, unknown>)) {
    const value = (where as Record<string, unknown>)[key];

    if (LOGICAL_KEYS.has(key)) {
      validateWhereIdentifiers(value, scope, clause);
      continue;
    }
    if (value === undefined || typeof value === "function") continue;

    assertKnownColumn(key, clause, scope);
  }
}

/** {@link whereLeafState} results, ordered so a larger value wins. */
const NO_LEAF = 0;
const UNDEFINED_LEAVES = 1;
const DEFINED_LEAF = 2;

/**
 * Whether a `where` names any field, and whether any named field has a value.
 *
 * Same traversal as {@link validateWhereIdentifiers}. It returns on the first
 * defined field without allocating (`for...in` rather than `Object.keys`),
 * because `findOne({ where: { id } })` is the hot read path and pays for this
 * check on every call. Function values are hook methods, so they count as
 * neither kind of leaf.
 */
function whereLeafState(where: unknown): number {
  if (where === null || typeof where !== "object") return NO_LEAF;

  let state = NO_LEAF;
  if (Array.isArray(where)) {
    for (let i = 0; i < where.length; i++) {
      const entry = whereLeafState(where[i]);
      if (entry === DEFINED_LEAF) return DEFINED_LEAF;
      if (entry > state) state = entry;
    }
    return state;
  }

  for (const key in where) {
    if (!Object.prototype.hasOwnProperty.call(where, key)) continue;
    const value = (where as Record<string, unknown>)[key];

    if (key === "OR" || key === "AND" || key === "NOT") {
      const nested = whereLeafState(value);
      if (nested === DEFINED_LEAF) return DEFINED_LEAF;
      if (nested > state) state = nested;
      continue;
    }
    if (typeof value === "function") continue;
    if (value !== undefined) return DEFINED_LEAF;
    state = UNDEFINED_LEAVES;
  }
  return state;
}

function collectUndefinedLeafPaths(
  where: unknown,
  path: string,
  out: string[],
): void {
  if (where === null || typeof where !== "object") return;

  if (Array.isArray(where)) {
    where.forEach((entry, i) =>
      collectUndefinedLeafPaths(entry, `${path}[${i}]`, out),
    );
    return;
  }

  const prefix = path ? `${path}.` : "";
  for (const key of Object.keys(where as Record<string, unknown>)) {
    const value = (where as Record<string, unknown>)[key];
    if (LOGICAL_KEYS.has(key)) {
      collectUndefinedLeafPaths(value, `${prefix}${key}`, out);
    } else if (value === undefined) {
      out.push(`${prefix}${key}`);
    }
  }
}

/**
 * The paths of the fields a vacuous `where` names, or null when it is not
 * vacuous.
 *
 * A where is vacuous when it names at least one field and every named field
 * is `undefined`. The resolver drops `undefined` fields, so such a where
 * resolves to no predicate at all. `{}`, `[]`, `{ OR: [] }` and a missing
 * where name no field, so they are not vacuous: they ask for no filter
 * explicitly. A where with at least one defined field is not vacuous either,
 * even when other fields are `undefined`; those are skipped as before.
 *
 * Paths use the where's own shape: `id`, `OR[0].status`, `NOT.score`,
 * `[1].title` for the array form.
 */
export function findVacuousWhere(where: unknown): string[] | null {
  if (whereLeafState(where) !== UNDEFINED_LEAVES) return null;
  const paths: string[] = [];
  collectUndefinedLeafPaths(where, "", paths);
  return paths;
}

/**
 * Rejects a vacuous `where` (see {@link findVacuousWhere}) on a read that
 * returns one row or a yes/no answer.
 *
 * Without it `findOne({ where: { id: maybeId } })` with `maybeId` undefined
 * ran `SELECT ... LIMIT 1` with no WHERE and returned an arbitrary row, and
 * `exists({ email: undefined })` answered "the table is not empty". List reads
 * and aggregates keep skipping `undefined` fields, and save()'s internal
 * readbacks do not come through here.
 */
export function assertWhereNotVacuous(
  where: unknown,
  method: "findOne" | "findOneBy" | "exists",
  entityName: string,
): void {
  const paths = findVacuousWhere(where);
  if (!paths) return;

  const consequence =
    method === "exists"
      ? "the check would match any row"
      : "the query would read an arbitrary row";
  throw new InvalidQueryError(
    `Every value in the "where" passed to ${method}() for entity "${entityName}" is undefined (${paths.join(", ")}) — ${consequence}.`,
    `An undefined value drops its condition instead of matching anything. Pass null to match IS NULL, or omit "where" to read without a filter.`,
  );
}

/**
 * Checks the SET payload of a criteria-based update. A SET clause maps
 * columns to values, so unlike a `where` it has no logical structure: a
 * combinator key is rejected by name rather than reported as an unknown
 * column, because "Unknown column "OR"" pointed users at the column list when
 * the fix is to move the key into `options.where`.
 *
 * Same value exemptions as {@link validateWhereIdentifiers}: `undefined`
 * fields are not written, and a function value is a hook method.
 */
export function validateUpdateDataIdentifiers(
  data: unknown,
  scope: ColumnNameScope,
): void {
  if (data === undefined || data === null || typeof data !== "object") return;

  for (const key of Object.keys(data as Record<string, unknown>)) {
    const value = (data as Record<string, unknown>)[key];

    if (LOGICAL_KEYS.has(key)) {
      throw new InvalidQueryError(
        `Logical combinator "${key}" is not allowed in the update data for entity "${scope.entityName}".`,
        `AND / OR / NOT filter rows; put them in options.where. The data argument maps columns to the values to write.`,
      );
    }
    if (value === undefined || typeof value === "function") continue;

    assertKnownColumn(key, "data", scope);
  }
}

/**
 * Rejects unresolvable column identifiers in a find option before the query is
 * built.
 *
 * Without it a typo reached the driver as a raw identifier and came back as a
 * dialect-specific error ("no such column", "Unknown column ... in 'where
 * clause'", "column ... does not exist") that named the typo but never the
 * alternatives — while the same typo in bulk-write criteria already listed the
 * valid columns.
 */
export function validateReadIdentifiers(
  findOption: {
    where?: unknown;
    orderBy?: unknown;
    groupBy?: readonly unknown[];
  },
  selectColumns: readonly string[] | undefined,
  scope: ColumnNameScope,
): void {
  validateWhereIdentifiers(findOption.where, scope);

  if (findOption.orderBy && typeof findOption.orderBy === "object") {
    for (const key of Object.keys(findOption.orderBy as Record<string, unknown>)) {
      // Falsy direction means "not ordered by this column" — the builder skips
      // the key entirely, so the guard does too.
      if (!(findOption.orderBy as Record<string, unknown>)[key]) continue;
      assertKnownColumn(key, "orderBy", scope);
    }
  }

  for (const column of selectColumns ?? []) {
    assertKnownColumn(String(column), "select", scope);
  }

  for (const column of findOption.groupBy ?? []) {
    assertKnownColumn(String(column), "groupBy", scope);
  }
}

/**
 * Scope for one entity's read query, assembled from the collaborators every
 * read handler already holds.
 *
 * Shared by `find*()` and the aggregate handler so `count()` and `find()`
 * accept exactly the same identifiers.
 */
export function buildEntityColumnScope(params: {
  entity: ClazzType<any>;
  metadata: { columns: ColumnMetadata[] };
  propertyToColumn: Map<string, string>;
  computedColumns?: Iterable<string> | null;
  inheritanceResolver?: InheritanceResolver | null;
}): ColumnNameScope {
  const { entity, inheritanceResolver } = params;
  const inHierarchy = inheritanceResolver
    ? inheritanceResolver.getStrategy(entity) !== null
    : false;
  const root = inHierarchy
    ? (inheritanceResolver!.getRoot(entity) ?? entity)
    : entity;

  return buildColumnNameScope({
    entityName: entity.name,
    columns: params.metadata.columns,
    propertyToColumn: params.propertyToColumn,
    computedColumns: params.computedColumns,
    // A single-table hierarchy shares one physical table, so a root query may
    // legitimately filter on a child class's column even though it is absent
    // from the root's own metadata.
    hierarchyColumns: inHierarchy
      ? inheritanceResolver!.getAllHierarchyColumns(root)
      : null,
    discriminatorColumn: inHierarchy
      ? (inheritanceResolver!.getDiscriminatorColumn(root)?.name ?? null)
      : null,
  });
}

/**
 * The keys of a write payload (save / saveMany / insertMany / upsert / …)
 * that name nothing on the entity, in first-seen order.
 *
 * Unlike the criteria and SET validators this never throws: the caller
 * applies the `unknownWriteKeys` policy (warn once, throw, ignore). The
 * exemptions match {@link validateWhereIdentifiers}: an `undefined` value is
 * "not provided" and is never written anyway, and a function-valued member
 * is a method on an entity instance, not data. Symbol keys are invisible to
 * `Object.keys` and so to this check — the WriteBuffer's per-instance
 * markers live there on purpose.
 */
export function collectUnknownWriteKeys(
  data: unknown,
  scope: ColumnNameScope,
): string[] {
  if (data === null || typeof data !== "object") return [];

  const unknown: string[] = [];
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (scope.valid.has(key)) continue;
    const value = (data as Record<string, unknown>)[key];
    if (value === undefined || typeof value === "function") continue;
    unknown.push(key);
  }
  return unknown;
}
