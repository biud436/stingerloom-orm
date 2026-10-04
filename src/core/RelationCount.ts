/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils/types";
import { InvalidQueryError } from "../errors";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import { collectRelationNames, relationEntryOf } from "./RelationNameValidator";
import { declaredComputedColumns } from "./generators/entityColumns";

/**
 * One count a read attaches to each entity it returns: the number of rows
 * a collection relation holds for that entity, written to `property`.
 */
export interface RelationCountSpec {
  /** The property of each entity the count is written to. */
  readonly property: string;
  /** The OneToMany / ManyToMany relation whose rows are counted. */
  readonly relation: string;
  /** Counts only the related rows that match — the related entity's where. */
  readonly where?: unknown;
  /** Counts soft-deleted related rows too, whatever the read says. */
  readonly withDeleted?: boolean;
}

const COUNT_OPTION_KEYS: ReadonlySet<string> = new Set(["relation", "where", "withDeleted"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object"
    ? `an object of class ${value.constructor?.name ?? "?"}`
    : `${typeof value} ${JSON.stringify(value)}`;
}

/** `"withCount"`, or the `withCount` of a relation under `relations`. */
function optionName(path: string): string {
  return path ? `"withCount" of relation "${path}" in "relations"` : '"withCount"';
}

/** `"withCount.<property>"`, placed under its relation when nested. */
function entryName(path: string, property: string): string {
  const entry = `"withCount.${property}"`;
  return path ? `${entry} of relation "${path}" in "relations"` : entry;
}

/**
 * Normalizes a `withCount` option — `{ property: "relation" }` or
 * `{ property: { relation, where, withDeleted } }` — into specs, checking
 * its shape only. Undefined when the option is absent or names nothing.
 *
 * @param path - The relation path the option sits under, empty at the top
 *   level of a read; only used in messages.
 */
export function parseWithCountOption(
  value: unknown,
  path = "",
): RelationCountSpec[] | undefined {
  if (value === undefined || value === null) return undefined;
  const name = optionName(path);
  if (!isPlainObject(value)) {
    throw new InvalidQueryError(
      `${name} must be an object keyed by the property each count is written to, got ${describe(value)}.`,
      'Write withCount: { commentCount: "comments" }.',
    );
  }

  const specs: RelationCountSpec[] = [];
  for (const [property, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (typeof entry === "string") {
      specs.push({ property, relation: entry });
      continue;
    }
    if (!isPlainObject(entry)) {
      throw new InvalidQueryError(
        `${entryName(path, property)} is ${describe(entry)}; expected a relation name or { relation, where, withDeleted }.`,
        `Write { ${property}: "comments" }, or { ${property}: { relation: "comments", where: { ... } } } to count only some rows.`,
      );
    }
    for (const key of Object.keys(entry)) {
      if (!COUNT_OPTION_KEYS.has(key)) {
        throw new InvalidQueryError(
          `Unknown option "${key}" in ${entryName(path, property)}.`,
          `Supported options: ${[...COUNT_OPTION_KEYS].join(", ")}.`,
        );
      }
    }
    const { relation, where, withDeleted } = entry;
    if (typeof relation !== "string" || relation.length === 0) {
      throw new InvalidQueryError(
        `${entryName(path, property)} needs "relation", the name of the relation to count, got ${describe(relation)}.`,
        `Write { ${property}: { relation: "comments" } }.`,
      );
    }
    const spec: { property: string; relation: string; where?: unknown; withDeleted?: boolean } = {
      property,
      relation,
    };
    if (where !== undefined) {
      const clauses = Array.isArray(where) ? where : [where];
      if (clauses.length === 0 || !clauses.every(isPlainObject)) {
        throw new InvalidQueryError(
          `"where" in ${entryName(path, property)} must be a where clause or a non-empty array of them, got ${describe(where)}.`,
          `Write { ${property}: { relation: "${relation}", where: { column: value } } }.`,
        );
      }
      spec.where = where;
    }
    if (withDeleted !== undefined) {
      if (typeof withDeleted !== "boolean") {
        throw new InvalidQueryError(
          `"withDeleted" in ${entryName(path, property)} must be a boolean, got ${describe(withDeleted)}.`,
          "Pass true to count soft-deleted related rows too, false to leave them out.",
        );
      }
      spec.withDeleted = withDeleted;
    }
    specs.push(spec);
  }
  return specs.length > 0 ? specs : undefined;
}

/**
 * Rejects a count no batched read can answer on `entity`, before any
 * statement runs: a relation the entity does not declare or that is not a
 * collection, a ManyToMany with no known join table, a parent keyed by more
 * than one column, and a property the entity already uses for a column or
 * a relation — the count would overwrite it.
 */
export function validateRelationCounts(
  entity: ClazzType<any>,
  specs: readonly RelationCountSpec[] | undefined,
  resolver: RelationMetadataResolver,
  path = "",
): void {
  if (!specs || specs.length === 0) return;

  const names = collectRelationNames(entity, resolver);
  const collections = [...names.oneToMany, ...names.manyToMany];
  const metadata = resolver.resolveEntityMetadata(entity);
  const taken = new Map<string, string>();
  for (const col of metadata?.columns ?? []) {
    if (col.propertyKey) taken.set(String(col.propertyKey), "a column");
    if (col.name) taken.set(col.name, "a column");
  }
  for (const computed of declaredComputedColumns(entity)) {
    taken.set(computed.propertyKey, "a computed column");
  }
  for (const [prop] of resolver.collectFkPropertyMappings(entity)) {
    taken.set(prop, "a foreign key property");
  }
  for (const relation of names.all) taken.set(relation, "a relation");

  for (const spec of specs) {
    const owner = taken.get(spec.property);
    if (owner) {
      throw new InvalidQueryError(
        `${entryName(path, spec.property)} would overwrite "${spec.property}", ${owner} of "${entity.name}".`,
        `Declare a separate property for the count, e.g. "${spec.relation}Count?: number", and key the count by it.`,
      );
    }

    const entry = relationEntryOf(entity, spec.relation, resolver);
    if (!entry) {
      throw new InvalidQueryError(
        `Unknown relation "${spec.relation}" in ${entryName(path, spec.property)} for entity "${entity.name}".`,
        collections.length > 0
          ? `Collection relations of "${entity.name}": ${collections.map((n) => `"${n}"`).join(", ")}.`
          : `"${entity.name}" declares no OneToMany or ManyToMany relation to count.`,
      );
    }
    if (entry.kind !== "OneToMany" && entry.kind !== "ManyToMany") {
      throw new InvalidQueryError(
        `${entryName(path, spec.property)} counts "${spec.relation}", a ${entry.kind} of "${entity.name}"; ` +
          "only collection relations (OneToMany, ManyToMany) can be counted.",
        `Load "${spec.relation}" with "relations" and check whether it is null instead.`,
      );
    }
    if (entry.kind === "ManyToMany") {
      const rel = resolver
        .resolveManyToManyMetadata(entity)
        .find((r) => r.propertyKey === spec.relation);
      if (!rel || !resolver.resolveManyToManyJoinTable(rel)) {
        throw new InvalidQueryError(
          `${entryName(path, spec.property)} counts "${spec.relation}", a ManyToMany of "${entity.name}" with no known join table.`,
          "Declare the join table on the owning side (joinTable) so the related rows can be counted.",
        );
      }
    }

    const keys = (metadata?.columns ?? []).filter((col) => col.options?.primary);
    if (keys.length > 1) {
      throw new InvalidQueryError(
        `${entryName(path, spec.property)} counts "${spec.relation}" per "${entity.name}", whose primary key has ${keys.length} columns; ` +
          "counts are matched to each entity by a single-column key.",
        `Count "${spec.relation}" with an aggregate grouped by the key columns instead.`,
      );
    }
  }
}

/**
 * Normalizes and validates the `withCount` option of a read on `entity`.
 * Undefined when the read counts nothing.
 */
export function resolveRelationCounts(
  entity: ClazzType<any>,
  value: unknown,
  resolver: RelationMetadataResolver,
): RelationCountSpec[] | undefined {
  const specs = parseWithCountOption(value);
  validateRelationCounts(entity, specs, resolver);
  return specs;
}
