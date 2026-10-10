/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils/types";

function extendsClass(entity: ClazzType<any>, ancestor: ClazzType<any>): boolean {
  for (
    let parent = Object.getPrototypeOf(entity);
    typeof parent === "function" && parent.prototype;
    parent = Object.getPrototypeOf(parent)
  ) {
    if (parent === ancestor) return true;
  }
  return false;
}

/**
 * An entity is in scope when it is listed in `scope` or shares an
 * inheritance chain (STI/TPT/TPC) with a listed class — querying a child of
 * a scoped parent (or the parent of scoped children) is a polymorphic query
 * against tables the connection owns.
 */
export function isInEntityScope(
  entity: ClazzType<any>,
  scope: readonly ClazzType<any>[],
): boolean {
  if (scope.includes(entity)) return true;
  return scope.some((scoped) => extendsClass(entity, scoped) || extendsClass(scoped, entity));
}
