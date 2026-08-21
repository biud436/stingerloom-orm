/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils/types";
import { InvalidQueryError } from "../errors";
import { closestIdentifier } from "../utils/closestIdentifier";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";

/**
 * Every relation name an entity can resolve on the read path, grouped by kind.
 *
 * The names come from the SAME resolver calls the loaders use
 * (`ReadExecutor` for ManyToOne/OneToOne-owning, `RelationLoader` for
 * OneToMany/ManyToMany/OneToOne-inverse), so the guard can never accept a name
 * the loaders reject — or reject one they would have loaded.
 */
export interface RelationNameIndex {
  manyToOne: string[];
  oneToMany: string[];
  manyToMany: string[];
  oneToOne: string[];
  /** Union of every name above, for O(1) membership tests. */
  all: Set<string>;
}

/**
 * Collects the relation names declared on an entity, in loader terms.
 *
 * ManyToOne entries are keyed by `columnName` (the property name) and every
 * other kind by `propertyKey` — matching the `relations.includes(...)` filters
 * in ReadExecutor / RelationLoader.
 */
export function collectRelationNames(
  entity: ClazzType<any>,
  resolver: RelationMetadataResolver,
): RelationNameIndex {
  return buildIndex(collectRelationEntries(entity, resolver));
}

/** One requested-relation candidate: its name, kind and lazy target thunk. */
interface RelationEntry {
  name: string;
  kind: "ManyToOne" | "OneToMany" | "ManyToMany" | "OneToOne";
  readTarget: () => unknown;
}

function collectRelationEntries(
  entity: ClazzType<any>,
  resolver: RelationMetadataResolver,
): RelationEntry[] {
  const entries: RelationEntry[] = [];
  const push = (
    name: unknown,
    kind: RelationEntry["kind"],
    readTarget: () => unknown,
  ) => {
    // A metadata entry without a usable name can never match a requested
    // relation (the loaders filter on the same field), so it contributes
    // nothing to the valid set — and must not reach the suggestion pass.
    if (typeof name !== "string" || name.length === 0) return;
    entries.push({ name, kind, readTarget });
  };

  for (const rel of resolver.resolveManyToOneMetadata(entity)) {
    push(rel.columnName, "ManyToOne", () => rel.getMappingEntity?.());
  }
  for (const rel of resolver.resolveOneToManyMetadata(entity)) {
    push(rel.propertyKey, "OneToMany", () => rel.getRelatedEntity?.());
  }
  for (const rel of resolver.resolveManyToManyMetadata(entity)) {
    push(rel.propertyKey, "ManyToMany", () => rel.getRelatedEntity?.());
  }
  for (const rel of resolver.resolveOneToOneMetadata(entity)) {
    push(rel.propertyKey, "OneToOne", () => rel.getRelatedEntity?.());
  }
  return entries;
}

function buildIndex(entries: RelationEntry[]): RelationNameIndex {
  const pick = (kind: RelationEntry["kind"]) =>
    entries.filter((e) => e.kind === kind).map((e) => e.name);
  const index: RelationNameIndex = {
    manyToOne: pick("ManyToOne"),
    oneToMany: pick("OneToMany"),
    manyToMany: pick("ManyToMany"),
    oneToOne: pick("OneToOne"),
    all: new Set(entries.map((e) => e.name)),
  };
  return index;
}

function describeAvailable(index: RelationNameIndex): string {
  const parts: string[] = [];
  for (const [kind, names] of [
    ["ManyToOne", index.manyToOne],
    ["OneToMany", index.oneToMany],
    ["ManyToMany", index.manyToMany],
    ["OneToOne", index.oneToOne],
  ] as const) {
    for (const name of names) parts.push(`${name} (${kind})`);
  }
  return parts.length > 0 ? `[${parts.join(", ")}]` : "none";
}

/**
 * Rejects `relations` entries that no loader can resolve.
 *
 * Before this guard a typo (`relations: ["porject"]`) produced no error at
 * all — every loader filters with `relations.includes(...)`, so an unmatched
 * name was silently dropped and the caller got rows whose relation property
 * stayed `undefined`. A silently wrong result is worse than a loud failure,
 * and the same typo in a bulk `updateMany` criteria already threw
 * ("Unknown column ... Valid columns: ..."), so the read path was the odd one
 * out.
 *
 * Only user-requested names are checked — eager relations are resolved from
 * metadata and can never be misspelled.
 */
export function validateRelationNames(
  entity: ClazzType<any>,
  relations: readonly string[] | undefined,
  resolver: RelationMetadataResolver,
): void {
  if (!relations || relations.length === 0) return;

  const entries = collectRelationEntries(entity, resolver);
  const index = buildIndex(entries);

  for (const name of relations) {
    if (index.all.has(name)) continue;

    // Nested paths ("author.profile") were never implemented — the loaders
    // match the whole string against a property name, so a dotted entry could
    // only ever no-op. Say so instead of dropping it.
    if (typeof name === "string" && name.includes(".")) {
      const root = name.split(".")[0];
      throw new InvalidQueryError(
        `Nested relation path "${name}" is not supported in "relations" for entity "${entity.name}". ` +
          `Available relations: ${describeAvailable(index)}.`,
        index.all.has(root)
          ? `Load "${root}" here and fetch its nested relation with a follow-up query, or mark the nested relation eager.`
          : `Relation paths must name a single relation property declared on "${entity.name}".`,
      );
    }

    const suggestion = closestIdentifier(String(name), index.all);
    throw new InvalidQueryError(
      `Unknown relation "${name}" in "relations" for entity "${entity.name}". ` +
        `Available relations: ${describeAvailable(index)}.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : ""),
      `Use one of the relation properties declared on "${entity.name}" ` +
        `with @ManyToOne / @OneToMany / @ManyToMany / @OneToOne, or add the missing decorator.`,
    );
  }

  assertRelationTargetsResolvable(entity, relations, entries);
}

/**
 * Catches the second silent drop: a relation whose lazy `() => Entity` thunk
 * yields nothing. ESM circular imports between entity modules leave the other
 * module's class binding uninitialized, and both loaders `continue` past it,
 * so the requested relation simply never appears on the result.
 */
function assertRelationTargetsResolvable(
  entity: ClazzType<any>,
  relations: readonly string[],
  entries: RelationEntry[],
): void {
  const requested = new Set(relations);

  for (const entry of entries) {
    if (!requested.has(entry.name)) continue;

    let resolved: unknown;
    try {
      resolved = entry.readTarget();
    } catch (error) {
      throw new InvalidQueryError(
        `Relation "${entry.name}" on entity "${entity.name}" could not resolve its target entity: ` +
          `${(error as Error)?.message ?? String(error)}`,
        "This is usually a circular import between entity modules. Keep the target behind the " +
          "decorator's lazy () => Entity thunk and type the property as Relation<Target>.",
      );
    }

    if (resolved === undefined || resolved === null) {
      throw new InvalidQueryError(
        `Relation "${entry.name}" on entity "${entity.name}" resolved to ${String(resolved)} — ` +
          `its @${entry.kind} target thunk returned no entity class, so the relation cannot be loaded.`,
        "This is usually a circular import between entity modules (ESM leaves the other module's " +
          "class binding uninitialized). Type single-valued relation properties as Relation<Target> " +
          "and make sure both modules finish loading before the query runs.",
      );
    }
  }
}
