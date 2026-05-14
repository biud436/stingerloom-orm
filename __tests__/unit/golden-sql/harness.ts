import "reflect-metadata";
import type { Sql } from "sql-template-tag";
import {
  createDialectExpression,
  type DialectExpression,
} from "../../../src/dialects/DialectExpression";
import { OrmError } from "../../../src/errors/OrmError";
import type { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

/**
 * Golden / snapshot SQL test harness.
 *
 * The query layer compiles a DSL tree into an exact SQL string per
 * dialect. A one-line change in a renderer can silently shift the emitted
 * SQL for a whole family of queries; these tests pin
 * **same DSL input -> exact rendered SQL string** so such a shift surfaces
 * as a failing diff instead of a production regression.
 *
 * Pure string rendering — no DB connection, runs in the unit suite.
 */

export type DialectName = "postgres" | "mysql" | "sqlite";

/** The dialects every golden case is rendered against. */
export const DIALECTS: readonly DialectName[] = [
  "postgres",
  "mysql",
  "sqlite",
] as const;

/**
 * Identifier-quoting resolver that mirrors each driver's
 * `escapeIdentifier()`: MySQL wraps in backticks, PostgreSQL and SQLite in
 * double quotes. `"alias.col"` becomes `"alias"."col"`, a bare ref becomes
 * `"ref"`, and `"*"` passes through verbatim.
 */
export function resolverFor(dialect: DialectName): (ref: string) => string {
  const q = dialect === "mysql" ? "`" : '"';
  const wrap = (s: string): string => `${q}${s.split(q).join(q + q)}${q}`;
  return (ref: string): string => {
    if (ref === "*") return "*";
    const dot = ref.indexOf(".");
    if (dot === -1) return wrap(ref);
    return `${wrap(ref.slice(0, dot))}.${wrap(ref.slice(dot + 1))}`;
  };
}

/** Cached `DialectExpression` for the given dialect. */
export function dialectExpressionFor(dialect: DialectName): DialectExpression {
  return createDialectExpression(dialect);
}

/**
 * Anything the expression layer can turn into an `Sql` value given an
 * `(resolveColumn, dialect)` pair. The various expression classes expose
 * the renderer under different method names — `compile()` dispatches on
 * whichever one is present.
 */
export type Renderable =
  | ((
      resolveColumn: (ref: string) => string,
      dialect: DialectExpression,
    ) => Sql)
  | { render(resolveColumn: unknown, dialect?: unknown): Sql }
  | { renderer(resolveColumn: unknown, dialect?: unknown): Sql }
  | { renderFunction(resolveColumn: unknown, dialect?: unknown): Sql }
  | { resolve(resolveColumn: unknown, dialect?: unknown): Sql };

function toSql(
  node: Renderable,
  resolveColumn: (ref: string) => string,
  dialect: DialectExpression,
): Sql {
  if (typeof node === "function") {
    return node(resolveColumn, dialect);
  }
  const n = node as Record<string, unknown>;
  // Priority order: a class exposes exactly one of these, but check the
  // most specific (`render`) first so an object that happens to also carry
  // a generic `resolve` is still rendered through its own method.
  for (const method of [
    "render",
    "renderer",
    "renderFunction",
    "resolve",
  ] as const) {
    if (typeof n[method] === "function") {
      return (n[method] as (r: unknown, d?: unknown) => Sql)(
        resolveColumn,
        dialect,
      );
    }
  }
  throw new Error(
    "golden-sql compile(): node exposes no known render method " +
      "(render / renderer / renderFunction / resolve).",
  );
}

/** Compile a renderable against one dialect into `{ text, values }`. */
export function compile(
  node: Renderable,
  dialect: DialectName,
): { text: string; values: unknown[] } {
  const out = toSql(node, resolverFor(dialect), dialectExpressionFor(dialect));
  return { text: out.sql, values: out.values };
}

/** Expected outcome for one dialect: a pinned SQL string or a thrown error. */
export type Expectation =
  | { text: string; values: readonly unknown[] }
  | { throws: OrmErrorCode };

/**
 * One golden case: a DSL builder plus the exact expected outcome per
 * dialect. `build` is a factory so each dialect renders a fresh tree.
 */
export interface GoldenCase {
  name: string;
  build: () => Renderable;
  postgres: Expectation;
  mysql: Expectation;
  sqlite: Expectation;
}

/**
 * Run a parametrized matrix: every case is rendered against all three
 * dialects. A `{ text, values }` expectation asserts the exact SQL; a
 * `{ throws }` expectation asserts the dialect rejects the DSL with the
 * given `OrmErrorCode` (e.g. ordered-set aggregates on MySQL/SQLite).
 */
export function runGoldenMatrix(
  suite: string,
  cases: readonly GoldenCase[],
): void {
  describe(suite, () => {
    for (const testCase of cases) {
      describe(testCase.name, () => {
        for (const dialect of DIALECTS) {
          const expectation = testCase[dialect];
          it(`renders for ${dialect}`, () => {
            if ("throws" in expectation) {
              let caught: unknown;
              try {
                compile(testCase.build(), dialect);
              } catch (error) {
                caught = error;
              }
              expect(caught).toBeInstanceOf(OrmError);
              expect((caught as OrmError).code).toBe(expectation.throws);
              return;
            }
            const { text, values } = compile(testCase.build(), dialect);
            expect(text).toBe(expectation.text);
            expect(values).toEqual(expectation.values);
          });
        }
      });
    }
  });
}
