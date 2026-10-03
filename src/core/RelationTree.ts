/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils/types";
import { InvalidQueryError } from "../errors";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import { relationEntryOf, validateRelationNames } from "./RelationNameValidator";

/**
 * How one relation's rows are read, from its entry in the object form of
 * `relations`. `where` is the related entity's own where clause, resolved
 * against its columns when the relation is loaded.
 */
export interface RelationQueryOptions {
  readonly where?: unknown;
  readonly orderBy?: Readonly<Record<string, "ASC" | "DESC">>;
  readonly take?: number;
  readonly skip?: number;
  readonly withDeleted?: boolean;
}

/**
 * One requested relation, how its rows are read, and the relations to load
 * on the entities it reaches.
 */
export interface RelationTreeNode {
  readonly name: string;
  /** Relations nested under this one; undefined when none were asked for. */
  readonly children: RelationTree | undefined;
  /** The relation's own query options; undefined when it has none. */
  readonly options: RelationQueryOptions | undefined;
}

/**
 * The `relations` option of a read, normalized from any of its forms —
 * names, dotted paths, the object form — into one tree. A relation named in
 * several places (`["comments", "comments.author"]`) is one node.
 */
export interface RelationTree {
  /** The relation names of this level, in request order. */
  readonly names: string[];
  readonly nodes: ReadonlyMap<string, RelationTreeNode>;
}

interface MutableNode {
  name: string;
  children: MutableTree | undefined;
  options: RelationQueryOptions | undefined;
}

interface MutableTree {
  names: string[];
  nodes: Map<string, MutableNode>;
}

/** Option keys a relation accepts in the object form of `relations`. */
const RELATION_OPTION_KEYS: ReadonlySet<string> = new Set([
  "relations",
  "where",
  "orderBy",
  "take",
  "skip",
  "withDeleted",
]);

/** Options that shape a collection — meaningless on a single-valued relation. */
const COLLECTION_OPTION_KEYS = ["where", "orderBy", "take", "skip"] as const;

function emptyTree(): MutableTree {
  return { names: [], nodes: new Map() };
}

function nodeOf(tree: MutableTree, name: string): MutableNode {
  let node = tree.nodes.get(name);
  if (!node) {
    node = { name, children: undefined, options: undefined };
    tree.nodes.set(name, node);
    tree.names.push(name);
  }
  return node;
}

function childTreeOf(node: MutableNode): MutableTree {
  return (node.children ??= emptyTree());
}

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
  return typeof value === "object" ? `an object of class ${value.constructor?.name ?? "?"}` : `${typeof value} ${JSON.stringify(value)}`;
}

function pathOf(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

function addPath(tree: MutableTree, entry: string, prefix: string): void {
  const segments = entry.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new InvalidQueryError(
      `Relation path "${pathOf(prefix, entry)}" in "relations" has an empty segment.`,
      'Separate relation names with single dots, e.g. "comments.author".',
    );
  }
  let level = tree;
  segments.forEach((segment, i) => {
    const node = nodeOf(level, segment);
    if (i < segments.length - 1) level = childTreeOf(node);
  });
}

function addRelations(tree: MutableTree, relations: unknown, prefix: string): void {
  const where = prefix ? `the "relations" of "${prefix}"` : '"relations"';

  if (Array.isArray(relations)) {
    for (const entry of relations) {
      if (typeof entry !== "string") {
        throw new InvalidQueryError(
          `${capitalize(where)} lists ${describe(entry)}; every entry must be a relation name or a dotted relation path.`,
          'Pass relation property names, e.g. ["author", "comments.author"].',
        );
      }
      addPath(tree, entry, prefix);
    }
    return;
  }

  if (isPlainObject(relations)) {
    for (const [name, spec] of Object.entries(relations)) {
      if (spec === undefined || spec === false) continue;
      if (spec === true) {
        nodeOf(tree, name);
        continue;
      }
      const path = pathOf(prefix, name);
      if (!isPlainObject(spec)) {
        throw new InvalidQueryError(
          `Relation "${path}" in "relations" is ${describe(spec)}; expected true, false or an options object.`,
          `Write { ${name}: true } to load it, or { ${name}: { relations: { ... } } } to load relations nested under it.`,
        );
      }
      for (const key of Object.keys(spec)) {
        if (!RELATION_OPTION_KEYS.has(key)) {
          throw new InvalidQueryError(
            `Unknown option "${key}" for relation "${path}" in "relations".`,
            `Supported options: ${[...RELATION_OPTION_KEYS].join(", ")}.`,
          );
        }
      }
      const node = nodeOf(tree, name);
      node.options = parseQueryOptions(spec, path);
      if (spec.relations !== undefined && spec.relations !== null) {
        addRelations(childTreeOf(node), spec.relations, path);
      }
    }
    return;
  }

  throw new InvalidQueryError(
    `${capitalize(where)} must be an array of relation names or an object keyed by relation name, got ${describe(relations)}.`,
    'Write relations: ["author"] or relations: { author: true }.',
  );
}

/**
 * The query options of one relation's entry, checked for shape. Undefined
 * when the entry sets none of them.
 */
function parseQueryOptions(
  spec: Record<string, unknown>,
  path: string,
): RelationQueryOptions | undefined {
  const { where, orderBy, take, skip, withDeleted } = spec;
  const options: {
    where?: unknown;
    orderBy?: Record<string, "ASC" | "DESC">;
    take?: number;
    skip?: number;
    withDeleted?: boolean;
  } = {};

  if (where !== undefined) {
    const clauses = Array.isArray(where) ? where : [where];
    if (clauses.length === 0 || !clauses.every(isPlainObject)) {
      throw new InvalidQueryError(
        `"where" of relation "${path}" in "relations" must be a where clause or a non-empty array of them, got ${describe(where)}.`,
        `Write { ${lastSegment(path)}: { where: { column: value } } }.`,
      );
    }
    options.where = where;
  }

  if (orderBy !== undefined) {
    if (!isPlainObject(orderBy)) {
      throw new InvalidQueryError(
        `"orderBy" of relation "${path}" in "relations" must be an object keyed by property, got ${describe(orderBy)}.`,
        `Write { ${lastSegment(path)}: { orderBy: { createdAt: "DESC" } } }.`,
      );
    }
    for (const [key, direction] of Object.entries(orderBy)) {
      if (direction !== "ASC" && direction !== "DESC") {
        throw new InvalidQueryError(
          `"orderBy.${key}" of relation "${path}" in "relations" is ${describe(direction)}; expected "ASC" or "DESC".`,
          'Sort directions are written in upper case: "ASC" or "DESC".',
        );
      }
    }
    options.orderBy = orderBy as Record<string, "ASC" | "DESC">;
  }

  for (const [key, value] of [["take", take], ["skip", skip]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new InvalidQueryError(
        `"${key}" of relation "${path}" in "relations" must be a non-negative integer, got ${describe(value)}.`,
        `"${key}" counts related rows per parent.`,
      );
    }
    options[key] = value;
  }

  if (withDeleted !== undefined) {
    if (typeof withDeleted !== "boolean") {
      throw new InvalidQueryError(
        `"withDeleted" of relation "${path}" in "relations" must be a boolean, got ${describe(withDeleted)}.`,
        "Pass true to include soft-deleted related rows, false to hide them.",
      );
    }
    options.withDeleted = withDeleted;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Normalizes a `relations` option into a {@link RelationTree} without
 * checking any name against the entity. Undefined when no option was given.
 */
export function parseRelationsOption(relations: unknown): RelationTree | undefined {
  if (relations === undefined || relations === null) return undefined;
  const tree = emptyTree();
  addRelations(tree, relations, "");
  return tree;
}

/**
 * Rejects every name in the tree no relation of the entity it is applied to
 * declares — the same check `relations` has always had at the top level,
 * repeated on each related entity with the path in the message.
 */
function validateRelationTree(
  entity: ClazzType<any>,
  tree: RelationTree,
  resolver: RelationMetadataResolver,
  path: string,
): void {
  validateRelationNames(entity, tree.names, resolver, path || undefined);
  for (const node of tree.nodes.values()) {
    const entry = relationEntryOf(entity, node.name, resolver);
    if (!entry) continue;
    if (node.options && entry.kind !== "OneToMany" && entry.kind !== "ManyToMany") {
      const misplaced = COLLECTION_OPTION_KEYS.filter((key) => node.options![key] !== undefined);
      if (misplaced.length > 0) {
        const keys = misplaced.map((key) => `"${key}"`).join(", ");
        throw new InvalidQueryError(
          `${keys} cannot be set on relation "${pathOf(path, node.name)}" in "relations": ` +
            `it is a ${entry.kind} of "${entity.name}", and ${misplaced.length > 1 ? "these options shape" : "this option shapes"} ` +
            "the rows of a collection relation (OneToMany, ManyToMany).",
          `Filter "${entity.name}" itself instead, or load "${node.name}" without ${keys}.`,
        );
      }
    }
    if (!node.children || node.children.names.length === 0) continue;
    validateRelationTree(entry.target, node.children, resolver, pathOf(path, node.name));
  }
}

/**
 * Normalizes and validates the `relations` option of a read on `entity`.
 * Undefined when the read named no relations.
 */
export function resolveRelationTree(
  entity: ClazzType<any>,
  relations: unknown,
  resolver: RelationMetadataResolver,
): RelationTree | undefined {
  const tree = parseRelationsOption(relations);
  if (tree && tree.names.length > 0) {
    validateRelationTree(entity, tree, resolver, "");
  }
  return tree;
}

/**
 * The relation names a `relations` option asks for at its top level;
 * undefined when no option was given. A plain array of names — the form
 * the read path hands on once it has resolved the tree — is returned as is.
 */
export function requestedRelationNames(relations: unknown): readonly string[] | undefined {
  if (relations === undefined || relations === null) return undefined;
  if (
    Array.isArray(relations) &&
    relations.every((name) => typeof name === "string" && !name.includes("."))
  ) {
    return relations as readonly string[];
  }
  return parseRelationsOption(relations)?.names;
}

/** True when any level of the tree goes deeper than its top level. */
export function hasNestedRelations(tree: RelationTree | undefined): boolean {
  if (!tree) return false;
  for (const node of tree.nodes.values()) {
    if (node.children && node.children.names.length > 0) return true;
  }
  return false;
}

/**
 * A stable string for the shape of a tree — `"author,comments(author)"` —
 * for memo keys. Empty for no tree.
 */
export function relationTreeKey(tree: RelationTree | undefined): string {
  if (!tree) return "";
  return tree.names
    .map((name) => {
      const children = tree.nodes.get(name)?.children;
      return children && children.names.length > 0
        ? `${name}(${relationTreeKey(children)})`
        : name;
    })
    .join(",");
}
