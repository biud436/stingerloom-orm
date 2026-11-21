/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `OrmErrorCode` used to carry two codes for "a query was rejected"
 * (`INVALID_QUERY` / `QUERY_ERROR`) and two for "validation failed"
 * (`VALIDATION_FAILED` / `VALIDATION_ERROR`), each produced by different
 * throw sites, so a handler matching one name missed the other half.
 * `QUERY_ERROR` and `VALIDATION_ERROR` are now deprecated aliases with the
 * canonical values, the former `QUERY_ERROR` sites report `INVALID_QUERY`,
 * the schema checks that reported `VALIDATION_ERROR` report `SCHEMA_ERROR`,
 * and `VALIDATION_FAILED` comes only from `ValidationError`.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { ValidationError } from "../../src/errors/ValidationError";
import { TransactionError } from "../../src/errors/TransactionError";
import { ReplicationRouter } from "../../src/dialects/ReplicationRouter";
import { RawQueryBuilder } from "../../src/core/RawQueryBuilder";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { coerceRow } from "../../src/core/RawValueCoercion";
import { readRowsWithShape } from "../../src/core/RowShapeReader";
import { renderComputedColumnExpression } from "../../src/core/expressions/ComputedColumnExpression";
import { escapeSqlLiteral } from "../../src/utils/escapeSqlLiteral";
import { defineRow } from "../../src/schema/defineRow";
import { t } from "../../src/schema";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { createMockEm } from "./helpers/mock-em";

function codeOf(fn: () => unknown): OrmErrorCode {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OrmError);
    return (e as OrmError).code;
  }
  throw new Error("expected the call to throw");
}

@Entity({ name: "alias_probe" })
class AliasProbe {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: "varchar", length: 50 })
  name!: string;
}

describe("OrmErrorCode duplicate codes", () => {
  it("gives every member its own value apart from the two deprecated aliases", () => {
    const byValue = new Map<string, string[]>();
    for (const [name, value] of Object.entries(OrmErrorCode)) {
      byValue.set(value, [...(byValue.get(value) ?? []), name]);
    }
    const shared = [...byValue.values()].filter((names) => names.length > 1);
    expect(shared).toEqual(
      expect.arrayContaining([
        ["INVALID_QUERY", "QUERY_ERROR"],
        ["VALIDATION_FAILED", "VALIDATION_ERROR"],
      ]),
    );
    expect(shared).toHaveLength(2);
  });

  it("keeps the deprecated names matching the canonical codes", () => {
    expect(OrmErrorCode.QUERY_ERROR).toBe("ORM_INVALID_QUERY");
    expect(OrmErrorCode.VALIDATION_ERROR).toBe("ORM_VALIDATION_FAILED");
  });

  it("does not produce the deprecated codes anywhere in src/", () => {
    const srcRoot = path.join(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = path.relative(srcRoot, full);
        if (rel === path.join("errors", "OrmErrorCode.ts")) continue;
        const text = fs.readFileSync(full, "utf8");
        const deprecated = /OrmErrorCode\.(QUERY_ERROR|VALIDATION_ERROR)\b/.test(text);
        const transactionCode =
          rel !== path.join("errors", "TransactionError.ts") &&
          /OrmErrorCode\.TRANSACTION_FAILED\b/.test(text);
        if (deprecated || transactionCode || /new TransactionError\(/.test(text)) {
          offenders.push(rel);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe("query rejections report INVALID_QUERY", () => {
  it("RawQueryBuilder.orderBy() with an unknown direction", () => {
    expect(
      codeOf(() =>
        new RawQueryBuilder().orderBy([{ column: "id", direction: "SIDEWAYS" as any }]),
      ),
    ).toBe(OrmErrorCode.INVALID_QUERY);
  });

  it("SelectQueryBuilder with an unknown ORDER BY direction", () => {
    const qb = new SelectQueryBuilder<AliasProbe>(AliasProbe, "p", createMockEm());
    qb.addOrderBy("name", "SIDEWAYS" as any);
    expect(codeOf(() => qb.getSql())).toBe(OrmErrorCode.INVALID_QUERY);
  });

  it("a getRawMany() coercion that fails", () => {
    expect(codeOf(() => coerceRow<{ n: bigint }>({ n: "abc" }, { n: "bigint" }))).toBe(
      OrmErrorCode.INVALID_QUERY,
    );
  });

  it("an em.query(shape) result without a declared column", () => {
    const Shape = defineRow({ id: t.int(), zone: t.varchar() });
    expect(codeOf(() => readRowsWithShape(Shape, [{ id: 1 }]))).toBe(
      OrmErrorCode.INVALID_QUERY,
    );
  });
});

describe("schema checks report SCHEMA_ERROR", () => {
  it("a @ComputedColumn builder that returns something it cannot render", () => {
    expect(
      codeOf(() => renderComputedColumnExpression(() => 42 as any, "postgres", (c) => c)),
    ).toBe(OrmErrorCode.SCHEMA_ERROR);
  });

  it("a null byte in a DDL literal", () => {
    expect(codeOf(() => escapeSqlLiteral("a\0b"))).toBe(OrmErrorCode.SCHEMA_ERROR);
  });
});

describe("VALIDATION_FAILED is only ValidationError", () => {
  it("is the code of ValidationError, which both names match", () => {
    const err = new ValidationError("name", "maxLength", "too long");
    expect(err.code).toBe(OrmErrorCode.VALIDATION_FAILED);
    expect(err.code).toBe(OrmErrorCode.VALIDATION_ERROR);
  });

  it("reports a replication option without a master or replicas as INVALID_CONFIG", () => {
    const node = { host: "h", port: 1, username: "u", password: "p", database: "d" };
    expect(codeOf(() => new ReplicationRouter({ slaves: [node] } as any))).toBe(
      OrmErrorCode.INVALID_CONFIG,
    );
    expect(codeOf(() => new ReplicationRouter({ master: node, slaves: [] } as any))).toBe(
      OrmErrorCode.INVALID_CONFIG,
    );
  });
});

describe("TransactionError", () => {
  it("stays constructible for code that throws it itself", () => {
    const err = new TransactionError("failed");
    expect(err).toBeInstanceOf(OrmError);
    expect(err.code).toBe(OrmErrorCode.TRANSACTION_FAILED);
  });
});
