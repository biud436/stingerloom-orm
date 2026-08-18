/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-require-imports */
import { pathToFileURL } from "url";
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

  // Dynamically load fast-glob (optional peer dependency).
  // `import()` works in both builds: the CJS build transpiles it to require(),
  // the ESM build keeps it as a real dynamic import (require() does not exist there).
  let fg: { sync: (patterns: string[], options?: any) => string[] };
  try {
    const fgModule: any = await import("fast-glob");
    fg = fgModule.default ?? fgModule;
  } catch {
    throw new OrmError(
      OrmErrorCode.MISSING_DEPENDENCY,
      'Package "fast-glob" is required for glob entity patterns.',
      "Install with: pnpm add fast-glob",
    );
  }

  // fast-glob requires forward slashes — normalise Windows backslashes
  const normalised = patterns.map((p) => p.replace(/\\/g, "/"));

  const resolvedCwd = cwd ?? process.cwd();

  const matched = fg.sync(normalised, {
    cwd: resolvedCwd,
    absolute: true,
  });

  if (matched.length === 0) {
    // Naming the working directory the patterns were resolved from is the
    // difference between a fixable error and a guess: a relative pattern that
    // matches when the app boots from its own directory matches nothing when a
    // CLI runs from the repository root.
    throw new OrmError(
      OrmErrorCode.ENTITY_GLOB_NO_MATCH,
      `Entity glob patterns matched no files: ${patterns.join(", ")} (resolved from ${resolvedCwd})`,
    );
  }

  const resolved: Function[] = [];

  for (const filePath of matched) {
    try {
      // CJS build: import() transpiles to require(), which needs a plain path.
      // ESM build: real import(), which needs a file:// URL to work on every OS
      // and can load both ESM and CJS entity files.
      const specifier =
        typeof require === "function"
          ? filePath
          : pathToFileURL(filePath).href;
      const mod: any = await import(specifier);

      const namespaces: any[] = [mod];
      if (mod.default && typeof mod.default === "object") {
        namespaces.push(mod.default);
      }
      for (const ns of namespaces) {
        for (const exportKey of Object.keys(ns)) {
          const value = ns[exportKey];
          if (typeof value === "function" && ReflectManager.isEntity(value)) {
            resolved.push(value);
          }
        }
      }
    } catch (err: any) {
      logger.warn(`Failed to load "${filePath}": ${err.message ?? err}`);
    }
  }

  // Deduplicate using Set
  const seen = new Set<Function>(classRefs);
  for (const entity of resolved) {
    seen.add(entity);
  }

  return [...seen];
}
