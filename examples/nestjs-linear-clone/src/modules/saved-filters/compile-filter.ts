import { BadRequestException } from "@nestjs/common";
import {
  Expressions,
  qAlias,
  SelectQueryBuilder,
} from "@stingerloom/orm";
import type { ConditionLike } from "@stingerloom/orm";
import { Issue } from "../issues/issue.entity";
import { FilterOp, SavedFilterDefinition } from "./dto/saved-filter.dto";

const ISSUE_FIELD_ALLOWLIST = new Set<string>([
  "id",
  "number",
  "title",
  "status",
  "priority",
  "estimate",
  "projectId",
  "sprintId",
  "assigneeId",
  "reporterId",
  "parentId",
  "createdAt",
  "completedAt",
  "version",
]);

const JSON_FIELDS = new Set<string>(["customFields"]);

const MAX_DEPTH = 5;
const MAX_LEAVES = 50;

export interface CompileFilterContext {
  userId: number | null;
}

function isLeaf(node: SavedFilterDefinition): node is FilterOp {
  return (
    typeof (node as FilterOp).op === "string" &&
    typeof (node as FilterOp).field === "string"
  );
}

function isAnd(
  node: SavedFilterDefinition,
): node is { and: SavedFilterDefinition[] } {
  return Array.isArray((node as { and?: unknown }).and);
}

function isOr(
  node: SavedFilterDefinition,
): node is { or: SavedFilterDefinition[] } {
  return Array.isArray((node as { or?: unknown }).or);
}

function isNot(
  node: SavedFilterDefinition,
): node is { not: SavedFilterDefinition } {
  return (
    typeof (node as { not?: unknown }).not === "object" &&
    (node as { not?: unknown }).not !== null
  );
}

export function validateFilter(def: SavedFilterDefinition): void {
  let leaves = 0;
  const walk = (node: SavedFilterDefinition, depth: number): void => {
    if (depth > MAX_DEPTH) {
      throw new BadRequestException({
        code: "FILTER_TOO_DEEP",
        message: `Filter depth exceeds ${MAX_DEPTH}`,
      });
    }
    if (node === null || typeof node !== "object") {
      throw new BadRequestException({
        code: "INVALID_FILTER",
        message: "Filter node must be an object",
      });
    }
    if (isAnd(node)) {
      if (node.and.length === 0) {
        throw new BadRequestException({
          code: "INVALID_FILTER",
          message: "AND group must have at least one child",
        });
      }
      for (const c of node.and) walk(c, depth + 1);
      return;
    }
    if (isOr(node)) {
      if (node.or.length === 0) {
        throw new BadRequestException({
          code: "INVALID_FILTER",
          message: "OR group must have at least one child",
        });
      }
      for (const c of node.or) walk(c, depth + 1);
      return;
    }
    if (isNot(node)) {
      walk(node.not, depth + 1);
      return;
    }
    if (!isLeaf(node)) {
      throw new BadRequestException({
        code: "INVALID_FILTER",
        message: "Leaf node must include `field` and `op`",
      });
    }
    leaves++;
    if (leaves > MAX_LEAVES) {
      throw new BadRequestException({
        code: "FILTER_TOO_LARGE",
        message: `Filter has more than ${MAX_LEAVES} leaf predicates`,
      });
    }
    validateLeaf(node);
  };
  walk(def, 1);
}

function validateLeaf(leaf: FilterOp): void {
  if (leaf.op === "jsonEq") {
    if (!JSON_FIELDS.has(leaf.field)) {
      throw new BadRequestException({
        code: "UNKNOWN_FIELD",
        message: `jsonEq is only allowed on JSON fields, got "${leaf.field}"`,
      });
    }
    if (!Array.isArray(leaf.path) || leaf.path.length === 0) {
      throw new BadRequestException({
        code: "INVALID_FILTER",
        message: "jsonEq requires a non-empty path array",
      });
    }
    for (const seg of leaf.path) {
      if (typeof seg !== "string") {
        throw new BadRequestException({
          code: "INVALID_FILTER",
          message: "jsonEq path segments must be strings",
        });
      }
    }
    return;
  }
  if (!ISSUE_FIELD_ALLOWLIST.has(leaf.field)) {
    throw new BadRequestException({
      code: "UNKNOWN_FIELD",
      message: `Field "${leaf.field}" is not allowed in saved filters`,
    });
  }
  if (
    (leaf.op === "in" || leaf.op === "any") &&
    !Array.isArray((leaf as { value: unknown }).value)
  ) {
    throw new BadRequestException({
      code: "INVALID_FILTER",
      message: `op "${leaf.op}" requires an array value`,
    });
  }
}

function leafToCondition(
  leaf: FilterOp,
  ctx: CompileFilterContext,
  // qAlias proxy is dynamic; typing it as the entity gives the cleanest call site.
  i: ReturnType<typeof qAlias<Issue>>,
): ConditionLike {
  if (leaf.op === "jsonEq") {
    let json = i.jsonField(leaf.field);
    for (const seg of leaf.path) {
      json = json[seg];
    }
    return json.eq(leaf.value);
  }

  const col = i.field(leaf.field);

  switch (leaf.op) {
    case "eq":
      return col.eq(leaf.value);
    case "ne":
      return col.neq(leaf.value);
    case "lt":
      return col.lt(leaf.value);
    case "le":
      return col.lte(leaf.value);
    case "gt":
      return col.gt(leaf.value);
    case "ge":
      return col.gte(leaf.value);
    case "in":
    case "any":
      return col.in(leaf.value);
    case "isNull":
      return col.isNull();
    case "isNotNull":
      return col.isNotNull();
    case "like":
      return col.like(leaf.value);
    case "me": {
      if (ctx.userId === null) {
        throw new BadRequestException({
          code: "INVALID_FILTER",
          message: 'op "me" requires an authenticated user',
        });
      }
      return col.eq(ctx.userId);
    }
  }
}

function nodeToCondition(
  node: SavedFilterDefinition,
  ctx: CompileFilterContext,
  i: ReturnType<typeof qAlias<Issue>>,
): ConditionLike {
  if (isAnd(node)) {
    const children = node.and.map((c) => nodeToCondition(c, ctx, i));
    if (children.length === 1) return children[0];
    return Expressions.and(children[0], ...children.slice(1));
  }
  if (isOr(node)) {
    const children = node.or.map((c) => nodeToCondition(c, ctx, i));
    if (children.length === 1) return children[0];
    return Expressions.or(children[0], ...children.slice(1));
  }
  if (isNot(node)) {
    return Expressions.not(nodeToCondition(node.not, ctx, i));
  }
  return leafToCondition(node, ctx, i);
}

/**
 * Compile a SavedFilterDefinition into a SelectQueryBuilder<Issue> transform.
 * Validates the AST first; throws BadRequestException with a structured
 * `code` on the first violation.
 */
export function compileFilter(
  def: SavedFilterDefinition,
  ctx: CompileFilterContext,
  alias = "i",
): (qb: SelectQueryBuilder<Issue>) => SelectQueryBuilder<Issue> {
  validateFilter(def);
  const i = qAlias(Issue, alias);
  const condition = nodeToCondition(def, ctx, i);
  return (qb) => qb.andWhere(condition);
}
