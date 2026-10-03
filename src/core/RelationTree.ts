/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils/types";
import { InvalidQueryError } from "../errors";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import { relationTargetOf, validateRelationNames } from "./RelationNameValidator";

/**
 * One requested relation and the relations to load on the entities it
 * reaches.
 */
export interface RelationTreeNode {
  readonly name: string;
  /** Relations nested under this one; undefined when none were asked for. */
  readonly children: RelationTree | undefined;
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
}

interface MutableTree {
  names: string[];
  nodes: Map<string, MutableNode>;
}

/** Option keys a relation accepts in the object form of `relations`. */
const RELATION_OPTION_KEYS: ReadonlySet<string> = new Set(["relations"]);

function emptyTree(): MutableTree {
  return { names: [], nodes: new Map() };
}

function nodeOf(tree: MutableTree, name: string): MutableNode {
  let node = tree.nodes.get(name);
  if (!node) {
    node = { name, children: undefined };
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
    if (!node.children || node.children.names.length === 0) continue;
    const target = relationTargetOf(entity, node.name, resolver);
    if (!target) continue;
    validateRelationTree(target, node.children, resolver, pathOf(path, node.name));
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
