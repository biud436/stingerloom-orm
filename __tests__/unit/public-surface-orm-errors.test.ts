/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The public expression helpers, decorators, metadata layers, NestJS module
 * and testing helpers report misuse as an `OrmError` with a code, the shape
 * the rest of the API already throws. They used to throw a bare `Error`, so a
 * handler that sorts failures by `e instanceof OrmError` / `e.code` sent them
 * to its "unexpected" branch.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { LogicalCondition } from "../../src/core/expressions/LogicalCondition";
import { coalesce } from "../../src/core/expressions/NullishExpression";
import { greatest, least } from "../../src/core/expressions/ComparisonExpression";
import { exists, notExists } from "../../src/core/expressions/SubqueryExpression";
import { ntile, nthValue } from "../../src/core/expressions/WindowFunctions";
import {
  buckets,
  CaseBuilder,
  CaseValueBuilder,
  mapValues,
} from "../../src/core/expressions/CaseExpression";
import { ScalarExpression } from "../../src/core/expressions/ScalarExpression";
import { logicalConditionNotRegistered } from "../../src/core/expressions/expressionErrors";
import { qAlias } from "../../src/core/SelectQueryBuilder";
import sql from "../../src/utils/sqlTag";
import { Entity, PrimaryGeneratedColumn, Column, Index, JsonIndex } from "../../src/decorators";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { MetadataLayer } from "../../src/metadata/MetadataLayer";
import { StingerloomOrmCoreModule } from "../../src/integration/nestjs/stingerloom-orm-core.module";
import { createMockRepository } from "../../src/testing/createMockRepository";
import { EntityManager } from "../../src/core/EntityManager";
import { escapeSqliteIdentifier } from "../../src/introspection/catalog/sqlite";

@Entity()
class PsoeItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  price!: number;

  @Column({ type: "json", nullable: true })
  data!: Record<string, unknown> | null;
}

/** Run `fn`, expect it to throw, and return what it threw. */
function caught(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new OrmError(OrmErrorCode.INVALID_QUERY, "expected the call to throw");
}

function expectOrmError(fn: () => unknown, code: OrmErrorCode, message: RegExp) {
  const error = caught(fn);
  expect(error).toBeInstanceOf(OrmError);
  expect(error.code).toBe(code);
  expect(error.message).toMatch(message);
  return error;
}

/** Resolves a column reference to its own quoted name. */
const noColumns = (ref: string) => `"${ref}"`;

describe("expression helpers report misuse as InvalidQueryError", () => {
  const i = qAlias(PsoeItem, "i");

  it.each([
    ["coalesce() with one argument", () => coalesce(1), /coalesce\(\) requires at least 2 arguments, got 1/],
    ["greatest() with one argument", () => greatest(1), /greatest\(\) requires at least 2 arguments, got 1/],
    ["least() with no argument", () => least(), /least\(\) requires at least 2 arguments, got 0/],
    ["ntile(0)", () => ntile(0), /ntile\(n\): n must be a positive integer, got 0/],
    ["nthValue(expr, 1.5)", () => nthValue(i.price, 1.5), /nthValue\(expr, n\).*got 1\.5/],
    ["exists() with a plain object", () => exists({} as any), /exists\(\) requires a SelectQueryBuilder-like argument/],
    ["notExists() with a plain object", () => notExists({} as any), /notExists\(\) requires a SelectQueryBuilder-like argument/],
    ["NOT with two children", () => new LogicalCondition("NOT", [i.price.eq(1), i.price.eq(2)]), /'NOT' expects exactly 1 child, got 2/],
    ["AND with no child", () => new LogicalCondition("AND", []), /'AND' expects at least 1 child, got 0/],
    ["mapValues() with an empty mapping", () => mapValues(i.price, {}), /mapping must contain at least one entry/],
    ["buckets() with no threshold", () => buckets(i.price, []), /thresholds must contain at least one entry/],
    ["buckets() on a subject without comparisons", () => buckets({} as any, [[1, "a"]]), /subject must expose/],
    ["column coalesce() with no fallback", () => i.price.coalesce(), /coalesce\(\) requires at least one fallback argument/],
    ["column greatest() with no other value", () => i.price.greatest(), /greatest\(\) requires at least one other argument/],
    ["column least() with no other value", () => i.price.least(), /least\(\) requires at least one other argument/],
  ])("%s", (_label, fn, message) => {
    const error = expectOrmError(fn, OrmErrorCode.INVALID_QUERY, message);
    expect(error).toBeInstanceOf(InvalidQueryError);
  });

  it("rejects a searched CASE used out of order", () => {
    const cond = i.price.gt(1);
    const finished = new CaseBuilder().when(cond).then(1).otherwise(0);
    expectOrmError(() => finished.when(cond), OrmErrorCode.INVALID_QUERY, /cannot add \.when\(\) after \.otherwise\(\)/);
    expectOrmError(() => finished.otherwise(2), OrmErrorCode.INVALID_QUERY, /\.otherwise\(\) already set/);
    expectOrmError(() => new CaseBuilder().end(), OrmErrorCode.INVALID_QUERY, /needs at least one WHEN\/THEN pair/);
    expectOrmError(() => new CaseBuilder().when({} as any), OrmErrorCode.INVALID_QUERY, /expects a ConditionLike argument/);
  });

  it("rejects a simple CASE used out of order", () => {
    const finished = new CaseValueBuilder(i.price).when(1, "a").otherwise("z");
    expectOrmError(() => finished.when(2, "b"), OrmErrorCode.INVALID_QUERY, /cannot add \.when\(\) after \.otherwise\(\)/);
    expectOrmError(() => finished.otherwise("y"), OrmErrorCode.INVALID_QUERY, /\.otherwise\(\) already set/);
    expectOrmError(() => new CaseValueBuilder(i.price).end(), OrmErrorCode.INVALID_QUERY, /needs at least one WHEN\/THEN pair/);
  });

  it("rejects an unsupported partitionBy argument when the window renders", () => {
    const window = ntile(4).partitionBy(42).orderBy(i.price.asc()).toScalar();
    expectOrmError(() => window.renderer(noColumns), OrmErrorCode.INVALID_QUERY, /partitionBy: unsupported argument of type number/);
  });

  it.each([
    ["a CAST", (e: ScalarExpression) => e.intValue(), /A CAST expression requires a DialectExpression/],
    ["a date component", (e: ScalarExpression) => e.year(), /A date component expression requires a DialectExpression/],
    ["indexOf()", (e: ScalarExpression) => e.indexOf("x"), /indexOf\(\) requires a DialectExpression/],
    ["greatest()", () => greatest(1, 2), /greatest\(\) requires a DialectExpression/],
  ])("reports %s rendered without a dialect", (_label, build, message) => {
    const expr = (build as (e: ScalarExpression) => ScalarExpression)(
      new ScalarExpression(() => sql`1`),
    );
    expectOrmError(() => expr.renderer(noColumns), OrmErrorCode.INVALID_QUERY, message);
  });

  it("reports a JSON path inside coalesce() rendered without a dialect", () => {
    const j = qAlias(PsoeItem, "j");
    const expr = coalesce(j.data as any, "fallback");
    expectOrmError(() => expr.renderer(noColumns), OrmErrorCode.INVALID_QUERY, /JsonPathExpression inside coalesce\(\)\/nullif\(\) requires a DialectExpression/);
  });

  it("describes the logical combinators missing as a configuration error", () => {
    const error = logicalConditionNotRegistered();
    expect(error).toBeInstanceOf(OrmError);
    expect(error.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error.suggestion).toMatch(/Import from '@stingerloom\/orm'/);
  });
});

describe("decorator misuse reports SCHEMA_ERROR", () => {
  it("@Index() without columns on a class", () => {
    expectOrmError(
      () => (Index() as any)(class Unindexed {}),
      OrmErrorCode.SCHEMA_ERROR,
      /@Index\(\) without columns must be used as a PropertyDecorator/,
    );
  });

  it("@JsonIndex on a symbol property", () => {
    expectOrmError(
      () => JsonIndex()(class Holder {}.prototype, Symbol("profile")),
      OrmErrorCode.SCHEMA_ERROR,
      /@JsonIndex must be used on a named property/,
    );
  });
});

describe("metadata layers report misuse as OrmError", () => {
  it("refuses a duplicate layer, a missing source layer and removing public", () => {
    const registry = MetadataLayerRegistry.getInstance();
    registry.addLayer("psoe_acme");
    try {
      expectOrmError(() => registry.addLayer("psoe_acme"), OrmErrorCode.INVALID_CONFIG, /Layer "psoe_acme" already exists/);
      expectOrmError(() => registry.copyLayer("psoe_ghost", "psoe_beta"), OrmErrorCode.INVALID_CONFIG, /Source layer "psoe_ghost" not found/);
      expectOrmError(() => registry.removeLayer("public"), OrmErrorCode.UNSUPPORTED_OPERATION, /Cannot remove "public" layer/);
    } finally {
      registry.removeLayer("psoe_acme");
    }
  });

  it("refuses to write to a read-only layer", () => {
    const layer = new MetadataLayer("base", true);
    expectOrmError(() => layer.set("k", 1), OrmErrorCode.UNSUPPORTED_OPERATION, /Cannot modify read-only layer: base/);
    expectOrmError(() => layer.delete("k"), OrmErrorCode.UNSUPPORTED_OPERATION, /Cannot delete from read-only layer: base/);
    expectOrmError(() => layer.clear(), OrmErrorCode.UNSUPPORTED_OPERATION, /Cannot clear read-only layer: base/);
  });
});

describe("integration and testing helpers report misuse as OrmError", () => {
  it("StingerloomOrmModule.forRootAsync() without a provider kind", () => {
    expectOrmError(
      () => StingerloomOrmCoreModule.forRootAsync({} as any),
      OrmErrorCode.INVALID_CONFIG,
      /requires one of useFactory, useClass, or useExisting/,
    );
  });

  it("the database tenant strategy without a MultiTenantEntityManager provider", async () => {
    const dyn = StingerloomOrmCoreModule.forRootAsync({
      useFactory: () => ({ type: "sqlite", database: ":memory:", entities: [] }) as any,
    });
    const emProvider = (dyn.providers as any[]).find((p) => p.provide === EntityManager);
    const error = await emProvider
      .useFactory({ tenantStrategy: "database" }, undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrmError);
    expect(error.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error.message).toMatch(/MultiTenantEntityManager provider is required/);
  });

  it("a mock repository method that was not mocked", () => {
    const repo = createMockRepository(PsoeItem);
    expectOrmError(() => repo.find(), OrmErrorCode.UNSUPPORTED_OPERATION, /method "find" was called but not mocked/);
  });

  it("a SQLite identifier with a NUL byte", () => {
    expectOrmError(() => escapeSqliteIdentifier("a\x00b"), OrmErrorCode.INVALID_QUERY, /contains a NUL or substitute character/);
  });

  it("a missing class-transformer peer", () => {
    jest.isolateModules(() => {
      jest.doMock("class-transformer", () => {
        throw new Error("Cannot find module 'class-transformer'");
      });
      const { ClassTransformerDeserializer } = require("../../src/core/deserializer/ClassTransformerDeserializer");
      const { OrmError: IsolatedOrmError } = require("../../src/errors/OrmError");
      // fastPath: false — the fast path hydrates a plain class without ever
      // loading class-transformer.
      const deserializer = new ClassTransformerDeserializer({ fastPath: false });
      const error = caught(() => deserializer.deserialize(PsoeItem, { id: 1, price: 2 }));
      expect(error).toBeInstanceOf(IsolatedOrmError);
      expect(error.code).toBe(OrmErrorCode.MISSING_DEPENDENCY);
      expect(error.message).toMatch(/Package "class-transformer" is required/);
      expect(error.suggestion).toMatch(/pnpm add class-transformer/);
      expect(error.cause).toBeInstanceOf(Error);
    });
    jest.dontMock("class-transformer");
  });
});

/**
 * The convention `UnsupportedExpressionError.ts` states — throw an OrmError,
 * not a bare `Error` — held only by habit, and 60 throws had drifted from it.
 * Errors the ORM throws on purpose carry a code; this keeps new ones from
 * slipping back.
 */
describe("src/ throws no bare Error", () => {
  const SRC = path.join(__dirname, "..", "..", "src");

  function walk(dir: string, files: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, files);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(full);
    }
    return files;
  }

  it("has no `throw new Error(` outside comments", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//")) return;
        if (/\bthrow\s+new\s+Error\s*\(/.test(code)) {
          offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
