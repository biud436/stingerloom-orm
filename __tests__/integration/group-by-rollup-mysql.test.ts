/**
 * MySQL (MariaDB) integration tests for multi-column GROUP BY and WITH ROLLUP.
 *
 * Multi-column groupBy through every entry point (find / findAndCount /
 * findWithPage / SelectQueryBuilder), plus what each builder does with
 * MySQL's `GROUP BY ... WITH ROLLUP`:
 *
 *  - RawQueryBuilder's string path passes entries through verbatim, so
 *    "role WITH ROLLUP" is the working escape hatch — rollup rows come back
 *    with NULL group columns (per-department subtotals + a grand total).
 *  - SelectQueryBuilder accepts a raw() Sql fragment for the same effect;
 *    a plain STRING entry is treated as a column reference and mangled into
 *    a quoted identifier, so it must never be used for ROLLUP.
 *  - The find() FindOption path validates identifiers, so "WITH ROLLUP"
 *    inside groupBy is rejected before reaching the driver.
 *
 * Only runs when INTEGRATION_TEST=true and MySQL is enabled.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getMySqlConfig } from "./helpers/driver-config";
import { qAlias } from "../../src/core/SelectQueryBuilder";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { sql, raw } from "../../src/utils/sqlTag";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { generateTableName } from "./helpers/create-test-entity";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const MYSQL_ENABLED =
  INTEGRATION && process.env.INTEGRATION_TEST_MYSQL !== "false";
const integrationDescribe = MYSQL_ENABLED ? describe : describe.skip;

interface EmployeeShape {
  id: number;
  departmentId: number;
  role: string;
  salary: number;
}

function asArray<T>(result: T | T[] | null): T[] {
  return result == null ? [] : Array.isArray(result) ? result : [result];
}

integrationDescribe("[Integration] MySQL: multi-column GROUP BY / WITH ROLLUP", () => {
  let conn: TestConnectionResult;
  let Employee: new () => EmployeeShape;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("gb_rollup");

    conn = await createTestConnection(
      { ...getMySqlConfig(), synchronize: true, logging: false },
      () => {
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: tableName })
        class EmployeeEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) departmentId!: number;
          @Column({ type: "varchar", length: 30 }) role!: string;
          @Column({ type: "int" }) salary!: number;
        }

        Employee = EmployeeEntity as any;
        return { entities: [EmployeeEntity] };
      },
    );

    const { em } = conn;
    // dept 1: admin x2, user x1 / dept 2: user x1, owner x1
    // → 4 base groups, 5 raw rows
    await em.save(Employee, { departmentId: 1, role: "admin", salary: 100 } as any);
    await em.save(Employee, { departmentId: 1, role: "admin", salary: 110 } as any);
    await em.save(Employee, { departmentId: 1, role: "user", salary: 80 } as any);
    await em.save(Employee, { departmentId: 2, role: "user", salary: 90 } as any);
    await em.save(Employee, { departmentId: 2, role: "owner", salary: 120 } as any);
  }, 30000);

  afterAll(async () => {
    try {
      await dropTestTable(tableName);
    } catch {
      /* ignore */
    }
    await conn.cleanup();
  }, 15000);

  // ── Multi-column groupBy through the FindOption path ──────

  it("find() with a multi-column groupBy returns one row per pair", async () => {
    const rows = asArray(
      await conn.em.find(Employee, {
        select: ["departmentId", "role"],
        groupBy: ["departmentId", "role"],
      } as any),
    );

    expect(rows).toHaveLength(4);
    const pairs = new Set(rows.map((r: any) => `${r.departmentId}:${r.role}`));
    expect(pairs).toEqual(new Set(["1:admin", "1:user", "2:user", "2:owner"]));
  });

  it("find() multi-column groupBy honors having", async () => {
    const rows = asArray(
      await conn.em.find(Employee, {
        select: ["departmentId", "role"],
        groupBy: ["departmentId", "role"],
        having: [sql`COUNT(*) >= ${2}`],
      } as any),
    );

    expect(rows).toHaveLength(1);
    expect((rows[0] as any).departmentId).toBe(1);
    expect((rows[0] as any).role).toBe("admin");
  });

  it("findAndCount() with a multi-column groupBy counts group pairs", async () => {
    const [rows, total] = await conn.em.findAndCount(Employee, {
      select: ["departmentId", "role"],
      groupBy: ["departmentId", "role"],
    } as any);

    expect(rows).toHaveLength(4);
    expect(total).toBe(4);
  });

  it("findWithPage() with a multi-column groupBy paginates over group pairs", async () => {
    const page = await conn.em.findWithPage(Employee, {
      select: ["departmentId", "role"],
      groupBy: ["departmentId", "role"],
      orderBy: { departmentId: "ASC", role: "ASC" },
      page: 1,
      pageSize: 3,
    } as any);

    expect(page.data).toHaveLength(3);
    expect(page.total).toBe(4);
    expect(page.totalPages).toBe(2);
    expect(page.hasNextPage).toBe(true);
  });

  it("rejects WITH ROLLUP smuggled into the find() groupBy option", async () => {
    // The FindOption path takes column identifiers only — raw SQL in an
    // entry must fail validation instead of reaching the driver.
    await expect(
      conn.em.find(Employee, {
        select: ["departmentId"],
        groupBy: ["departmentId WITH ROLLUP"],
      } as any),
    ).rejects.toThrow(InvalidQueryError);
  });

  // ── Multi-column groupBy through SelectQueryBuilder ───────

  it("SelectQueryBuilder groups by multiple columns with per-group aggregates", async () => {
    const e = qAlias(Employee, "e");
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .select([e.departmentId.as("departmentId"), e.role.as("role"), e.id.count().as("cnt")])
      .groupBy(["e.departmentId", "e.role"])
      .getRawMany();

    expect(rows).toHaveLength(4);
    const admin1 = rows.find(
      (r: any) => r.departmentId === 1 && r.role === "admin",
    );
    expect(Number((admin1 as any).cnt)).toBe(2);
  });

  // ── WITH ROLLUP ───────────────────────────────────────────

  it("RawQueryBuilder string path passes WITH ROLLUP through verbatim", async () => {
    const built = conn.em
      .createQueryBuilder()
      .select(["departmentId", "role", "COUNT(*) AS cnt"])
      .from(`\`${tableName}\``)
      .where([])
      .groupBy(["departmentId", "role WITH ROLLUP"])
      .build();

    expect(built.sql).toContain("GROUP BY departmentId, role WITH ROLLUP");

    const rows = (await conn.em.query(built)) as any[];
    // 4 base groups + 2 per-department subtotals (role NULL) + 1 grand total
    expect(rows).toHaveLength(7);

    const grandTotal = rows.find(
      (r) => r.departmentId === null && r.role === null,
    );
    expect(Number(grandTotal.cnt)).toBe(5);

    const dept1Subtotal = rows.find(
      (r) => r.departmentId === 1 && r.role === null,
    );
    expect(Number(dept1Subtotal.cnt)).toBe(3);

    const dept2Subtotal = rows.find(
      (r) => r.departmentId === 2 && r.role === null,
    );
    expect(Number(dept2Subtotal.cnt)).toBe(2);
  });

  it("SelectQueryBuilder supports WITH ROLLUP via a raw() Sql fragment", async () => {
    const e = qAlias(Employee, "e");
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .select([e.departmentId.as("departmentId"), e.role.as("role"), e.id.count().as("cnt")])
      .groupBy([raw("`e`.`departmentId`, `e`.`role` WITH ROLLUP")])
      .getRawMany();

    expect(rows).toHaveLength(7);
    const grandTotal = rows.find(
      (r: any) => r.departmentId === null && r.role === null,
    );
    expect(Number((grandTotal as any).cnt)).toBe(5);
  });

  it("SelectQueryBuilder string entries treat WITH ROLLUP as a column name (documented mangling)", () => {
    // A plain string groupBy entry is a column reference: it is resolved and
    // quoted whole, so "role WITH ROLLUP" becomes a single (nonexistent)
    // identifier. Pinned so the raw() escape hatch above stays the documented
    // route for ROLLUP.
    const e = qAlias(Employee, "e");
    const { text } = conn.em
      .createQueryBuilder(Employee, "e")
      .select([e.departmentId.as("departmentId"), e.id.count().as("cnt")])
      .groupBy(["role WITH ROLLUP"])
      .getSql();

    expect(text).toContain("`e`.`role WITH ROLLUP`");
  });
});
