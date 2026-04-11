/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-require-imports */
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { Logger } from "./Logger";
import { ReflectManager } from "./ReflectManager";

const logger = new Logger("resolveEntityGlobs");

/**
 * Resolves an array of entity classes and/or glob patterns into entity classes.
 *
 * Class references are passed through as-is. Glob pattern strings are resolved
 * using `fast-glob` (optional peer dependency), and each matched file is
 * `require()`-d — only exports decorated with `@Entity()` are collected.
 *
 * @param entities - Mixed array of entity class constructors and glob pattern strings
 * @param cwd - Working directory for glob resolution (defaults to `process.cwd()`)
 * @returns Deduplicated array of entity class constructors
 */
export async function resolveEntityGlobs(
  entities: (Function | string)[],
  cwd?: string,
): Promise<Function[]> {
  const classRefs: Function[] = [];
  const patterns: string[] = [];

  for (const entry of entities) {
    if (typeof entry === "string") {
      patterns.push(entry);
    } else {
      classRefs.push(entry);
    }
  }

  // Fast path: no glob strings → skip fast-glob entirely
  if (patterns.length === 0) {
    return classRefs;
  }

  // Dynamically require fast-glob (optional peer dependency)
  let fg: { sync: (patterns: string[], options?: any) => string[] };
  try {
    fg = require("fast-glob");
  } catch {
    throw new OrmError(
      OrmErrorCode.MISSING_DEPENDENCY,
      'Package "fast-glob" is required for glob entity patterns.',
      "Install with: pnpm add fast-glob",
    );
  }

  // fast-glob requires forward slashes — normalise Windows backslashes
  const normalised = patterns.map((p) => p.replace(/\\/g, "/"));

  const matched = fg.sync(normalised, {
    cwd: cwd ?? process.cwd(),
    absolute: true,
  });

  if (matched.length === 0) {
    throw new OrmError(
      OrmErrorCode.ENTITY_GLOB_NO_MATCH,
      `Entity glob patterns matched no files: ${patterns.join(", ")}`,
    );
  }

  const resolved: Function[] = [];

  for (const filePath of matched) {
    try {
      const mod = require(filePath);

      for (const exportKey of Object.keys(mod)) {
        const value = mod[exportKey];
        if (typeof value === "function" && ReflectManager.isEntity(value)) {
          resolved.push(value);
        }
      }
    } catch (err: any) {
      logger.warn(`Failed to require "${filePath}": ${err.message ?? err}`);
    }
  }

  // Deduplicate using Set
  const seen = new Set<Function>(classRefs);
  for (const entity of resolved) {
    seen.add(entity);
  }

  return [...seen];
}
