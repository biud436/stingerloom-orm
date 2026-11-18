/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils/types";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { closestIdentifier } from "../utils/closestIdentifier";
import { ReflectManager } from "../utils/ReflectManager";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { EntityScanner } from "../scanner";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import { isInEntityScope } from "./entity-manager/entity-scope";
import { ENTITY_TOKEN } from "../decorators/Entity";
import type { ManyToManyMetadata } from "../decorators/ManyToMany";

type RelationKind = "ManyToOne" | "OneToMany" | "ManyToMany" | "OneToOne";

/**
 * Checks, at register(), that every relation of the entities a connection
 * registers resolves the way the loaders and writers will resolve it:
 *
 * - its target is an entity in the connection's `entities` (or, with an
 *   empty `entities`, any entity) — otherwise the first statement that
 *   names it dies with "no such table";
 * - a `@OneToMany` `mappedBy` names a `@ManyToOne` (or the FK column) on
 *   the target — otherwise the loader selects a column that does not exist;
 * - a `@OneToOne` `inverseSide` names the owning `@OneToOne` on the target —
 *   otherwise the relation always loads as null;
 * - a `@ManyToMany` has a join table, its own `joinTable` or the one its
 *   `mappedBy` names — otherwise no join table is created and the relation
 *   never loads;
 * - with `createsForeignKeys` (synchronize builds the schema), a relation's
 *   foreign key constraint points at a single column — a composite primary
 *   key needs `referencedColumn`, or the constraint references part of the
 *   key;
 * - with `createsForeignKeys`, two `@ManyToMany` relations that declare the
 *   same `joinTable` name declare the same columns for the same tables —
 *   the schema creates one table per name, so the second relation would
 *   read and write a table built for the first. Both sides of one relation
 *   may each declare it, mirrored.
 *
 * Every problem is listed in one SCHEMA_ERROR, before any DDL runs.
 * `attach()` does not run it: an attached EntityManager may be scoped to a
 * subset of the tables another registration owns.
 *
 * @internal Package-internal — not a public API.
 */
export function validateRelationGraph(
  scope: readonly ClazzType<any>[],
  resolver: RelationMetadataResolver,
  connectionName?: string,
  options: { createsForeignKeys?: boolean } = {},
): void {
  const entities =
    scope.length > 0
      ? scope
      : [...getScannerInstance(EntityScanner).makeEntities()].map((m) => m.target as ClazzType<any>);

  // An inherited relation is reached through the parent and every child:
  // the same declaration yields the same line, reported once.
  const problems = new Set<string>();
  const joinTables = new Map<string, JoinTableClaim>();
  for (const entity of entities) {
    if (typeof entity !== "function") continue;
    checkEntity(entity, scope, resolver, problems, options.createsForeignKeys === true, joinTables);
  }

  if (problems.size > 0) {
    const connSuffix = connectionName ? ` (connection "${connectionName}")` : "";
    throw new OrmError(
      OrmErrorCode.SCHEMA_ERROR,
      `Invalid relation mapping${connSuffix}:\n  - ${[...problems].join("\n  - ")}`,
      "Fix the relation declarations listed above; each line starts with the entity property that declares it.",
    );
  }
}

function checkEntity(
  entity: ClazzType<any>,
  scope: readonly ClazzType<any>[],
  resolver: RelationMetadataResolver,
  problems: Set<string>,
  createsForeignKeys: boolean,
  joinTables: Map<string, JoinTableClaim>,
): void {
  // A relation declares a foreign key constraint when synchronize builds the
  // schema and the relation does not opt out of the constraint.
  const declaresForeignKey = (rel: { option?: { createForeignKeyConstraints?: boolean } }) =>
    createsForeignKeys && rel.option?.createForeignKeyConstraints !== false;
  const site = (rel: { target?: unknown }, property: string, kind: RelationKind) =>
    `${nameOf(rel.target, entity)}.${property}: @${kind}`;

  for (const rel of resolver.resolveManyToOneMetadata(entity)) {
    const at = site(rel, rel.columnName, "ManyToOne");
    const target = checkTarget(at, () => rel.getMappingEntity(), scope, problems);
    if (target && !rel.references && declaresForeignKey(rel)) {
      checkSingleColumnKey(at, target, resolver, problems, true);
    }
  }

  for (const rel of resolver.resolveOneToManyMetadata(entity)) {
    const at = site(rel, rel.propertyKey, "OneToMany");
    const target = checkTarget(at, () => rel.getRelatedEntity(), scope, problems);
    if (target) checkMappedByManyToOne(at, rel.mappedBy, target, resolver, problems);
  }

  for (const rel of resolver.resolveOneToOneMetadata(entity)) {
    const at = site(rel, rel.propertyKey, "OneToOne");
    const target = checkTarget(at, () => rel.getRelatedEntity(), scope, problems);
    if (target && !rel.joinColumn && rel.inverseSide) {
      checkInverseSide(at, rel.inverseSide, target, resolver, problems);
    }
    if (
      target &&
      rel.joinColumn &&
      !(rel as { references?: string }).references &&
      declaresForeignKey(rel as { option?: { createForeignKeyConstraints?: boolean } })
    ) {
      checkSingleColumnKey(at, target, resolver, problems, true);
    }
  }

  for (const rel of resolver.resolveManyToManyMetadata(entity)) {
    const at = site(rel, rel.propertyKey, "ManyToMany");
    const target = checkTarget(at, () => rel.getRelatedEntity(), scope, problems);
    if (target && !rel.joinTable) {
      checkJoinTableSource(at, rel.mappedBy, entity, target, resolver, problems);
    }
    // Each join table column references one side's key.
    if (createsForeignKeys) {
      checkSingleColumnKey(at, entity, resolver, problems, false);
      if (target) checkSingleColumnKey(at, target, resolver, problems, false);
      if (target && rel.joinTable) {
        checkJoinTableClaim(at, `${nameOf(rel.target, entity)}.${rel.propertyKey}`, rel, target, joinTables, problems);
      }
    }
  }
}

/** A `@ManyToMany` declaration that names a join table, by the columns it gives it. */
type JoinTableClaim = {
  /** `Entity.property` of the declaration. */
  label: string;
  declaring: unknown;
  propertyKey: string;
  /** Each column with the table its values come from, in declaration order. */
  columns: [string, string][];
};

/**
 * The schema builders create one join table per name, the first declaration
 * they meet wins, and the rest are skipped. A later declaration is fine only
 * when it gives the table the same columns for the same tables, which is
 * what both sides of one relation do when each declares it.
 */
function checkJoinTableClaim(
  at: string,
  label: string,
  rel: ManyToManyMetadata<any>,
  target: ClazzType<any>,
  joinTables: Map<string, JoinTableClaim>,
  problems: Set<string>,
): void {
  const { name, joinColumn, inverseJoinColumn } = rel.joinTable!;
  if (typeof name !== "string") return;
  const claim: JoinTableClaim = {
    label,
    declaring: rel.target,
    propertyKey: rel.propertyKey,
    columns: [
      [joinColumn, tableOf(rel.target)],
      [inverseJoinColumn, tableOf(target)],
    ],
  };
  const first = joinTables.get(name);
  if (!first) {
    joinTables.set(name, claim);
    return;
  }
  // An inherited relation is the same declaration reached again.
  if (first.declaring === claim.declaring && first.propertyKey === claim.propertyKey) return;
  const shape = (c: JoinTableClaim) => c.columns.map(([col, table]) => `${col}\u0000${table}`).sort().join("\u0001");
  if (shape(first) === shape(claim)) return;

  const describe = (c: JoinTableClaim) => c.columns.map(([col, table]) => `${col} (${table})`).join(" and ");
  const tables = (c: JoinTableClaim) => c.columns.map(([, table]) => table).sort().join("\u0001");
  problems.add(
    `${at} declares joinTable "${name}" with columns ${describe(claim)}, but ${first.label} already declares it with ${describe(first)}. ` +
      `Only one table of that name is created, so this relation would read and write the table built for the other. ` +
      `Give each relation its own join table name.` +
      (tables(first) === tables(claim)
        ? ` If the two are one relation seen from both sides, declare joinTable on one side and mappedBy on the other.`
        : ""),
  );
}

/** The table name the join table DDL gives a side's foreign key. */
function tableOf(cls: unknown): string {
  const meta = typeof cls === "function" ? (Reflect.getMetadata(ENTITY_TOKEN, cls) as { name?: string } | undefined) : undefined;
  return meta?.name ?? (typeof cls === "function" ? cls.name : String(cls));
}

/** The relation's target class, or undefined after recording why it cannot be used. */
function checkTarget(
  at: string,
  read: () => unknown,
  scope: readonly ClazzType<any>[],
  problems: Set<string>,
): ClazzType<any> | undefined {
  let target: unknown;
  try {
    target = read();
  } catch (e) {
    problems.add(`${at} could not read its target: ${(e as Error)?.message ?? String(e)}.`);
    return undefined;
  }
  if (typeof target !== "function") {
    problems.add(
      `${at} targets ${String(target)}: the target class was not defined yet when the relation was read, usually because of a circular import.`,
    );
    return undefined;
  }
  const name = (target as ClazzType<any>).name || "an anonymous class";
  if (!ReflectManager.isEntity(target)) {
    problems.add(`${at} targets ${name}, which is not an entity. Decorate it with @Entity().`);
    return undefined;
  }
  if (scope.length > 0 && !isInEntityScope(target as ClazzType<any>, scope)) {
    problems.add(
      `${at} targets ${name}, which is not in this connection's entities, so its table is never created. Add ${name} to entities.`,
    );
    return undefined;
  }
  return target as ClazzType<any>;
}

/**
 * The loaders and the cascade match `mappedBy` against the target's
 * `@ManyToOne` properties first and fall back to using it as the FK
 * column name, so either form is accepted.
 */
function checkMappedByManyToOne(
  at: string,
  mappedBy: unknown,
  target: ClazzType<any>,
  resolver: RelationMetadataResolver,
  problems: Set<string>,
): void {
  const owners = resolver.resolveManyToOneMetadata(target);
  if (typeof mappedBy !== "string" || mappedBy.length === 0) {
    problems.add(`${at} declares no mappedBy. ${namesManyToOnes(target, owners)}`);
    return;
  }
  if (owners.some((m) => m.columnName === mappedBy || m.joinColumn === mappedBy)) return;
  const columns = resolver.resolveEntityMetadata(target)?.columns ?? [];
  if (columns.some((c) => c.name === mappedBy)) return;

  const suggestion = closestIdentifier(mappedBy, owners.map((m) => m.columnName));
  problems.add(
    `${at} mappedBy "${mappedBy}" names no @ManyToOne on ${target.name}.` +
      (suggestion ? ` Did you mean "${suggestion}"?` : ` ${namesManyToOnes(target, owners)}`),
  );
}

function namesManyToOnes(target: ClazzType<any>, owners: readonly { columnName: string }[]): string {
  if (owners.length === 0) return `${target.name} declares no @ManyToOne pointing back.`;
  return `The @ManyToOne properties of ${target.name} are: ${owners.map((m) => `"${m.columnName}"`).join(", ")}.`;
}

/** The loader reads an inverse `@OneToOne` through the owning side's join column. */
function checkInverseSide(
  at: string,
  inverseSide: string,
  target: ClazzType<any>,
  resolver: RelationMetadataResolver,
  problems: Set<string>,
): void {
  const counterparts = resolver.resolveOneToOneMetadata(target);
  if (counterparts.some((r) => r.propertyKey === inverseSide && r.joinColumn)) return;
  if (counterparts.some((r) => r.propertyKey === inverseSide)) {
    problems.add(
      `${at} inverseSide "${inverseSide}" names ${target.name}.${inverseSide}, which holds no join column either. ` +
        `Give one side the join column (@RelationColumn) and point the other at it with inverseSide.`,
    );
    return;
  }
  const owning = counterparts.filter((r) => r.joinColumn).map((r) => r.propertyKey);
  const suggestion = closestIdentifier(inverseSide, owning);
  problems.add(
    `${at} inverseSide "${inverseSide}" names no owning @OneToOne on ${target.name}.` +
      (suggestion ? ` Did you mean "${suggestion}"?` : ""),
  );
}

/** Same resolution as `RelationMetadataResolver.resolveManyToManyJoinTable`. */
function checkJoinTableSource(
  at: string,
  mappedBy: string | undefined,
  entity: ClazzType<any>,
  target: ClazzType<any>,
  resolver: RelationMetadataResolver,
  problems: Set<string>,
): void {
  const others = resolver.resolveManyToManyMetadata(target);
  if (mappedBy) {
    const owner = others.find((r) => r.propertyKey === mappedBy);
    if (owner?.joinTable) return;
    if (owner) {
      problems.add(
        `${at} mappedBy "${mappedBy}" names ${target.name}.${mappedBy}, which declares no joinTable either, so the relation has no join table. ` +
          `Declare joinTable on one side and mappedBy on the other.`,
      );
      return;
    }
    const suggestion = closestIdentifier(mappedBy, others.map((r) => r.propertyKey));
    problems.add(
      `${at} mappedBy "${mappedBy}" names no @ManyToMany on ${target.name}.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : ""),
    );
    return;
  }
  const owningBack = others.find(
    (r) => r.joinTable && safeTarget(() => r.getRelatedEntity()) === entity,
  );
  problems.add(
    `${at} declares neither joinTable nor mappedBy, so the relation has no join table.` +
      (owningBack
        ? ` ${target.name}.${owningBack.propertyKey} declares one: add mappedBy: "${owningBack.propertyKey}".`
        : ` Declare joinTable on one side and mappedBy on the other.`),
  );
}

/**
 * A foreign key column holds one value, and the schema, the writers and the
 * loaders all pair it with the first primary key column of the entity it
 * points at. Against a composite key the constraint synchronize creates
 * references a column that is not unique: PostgreSQL rejects the constraint, SQLite rejects every write to
 * either table with "foreign key mismatch". `canNameColumn` says whether the relation can name the column it
 * references instead (`referencedColumn`).
 */
function checkSingleColumnKey(
  at: string,
  keyed: ClazzType<any>,
  resolver: RelationMetadataResolver,
  problems: Set<string>,
  canNameColumn: boolean,
): void {
  const columns = resolver.resolveEntityMetadata(keyed)?.columns ?? [];
  const keyColumns = columns.filter((c) => c.options?.primary).map((c) => c.name);
  if (keyColumns.length < 2) return;
  problems.add(
    `${at} needs a single-column key on ${keyed.name}, which has the composite primary key (${keyColumns.join(", ")}): ` +
      `a foreign key column cannot reference it. ` +
      (canNameColumn
        ? `Name a unique column of ${keyed.name} with @RelationColumn({ referencedColumn }), or give ${keyed.name} a single-column primary key.`
        : `Give ${keyed.name} a single-column primary key.`),
  );
}

function safeTarget(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function nameOf(declaring: unknown, fallback: ClazzType<any>): string {
  return typeof declaring === "function" && declaring.name ? declaring.name : fallback.name;
}
