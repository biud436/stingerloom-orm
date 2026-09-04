/**
 * @ComputedColumn 런타임 synchronize 통합 테스트 (V5-T0-3)
 *
 * 결함(2026-08-31 재현): GENERATED ALWAYS AS DDL은 migrate:generate 전용
 * SchemaGenerator에만 있었고, 런타임 synchronize의 driver.createTable()은
 * 계산 컬럼 메타데이터를 아예 보지 않아 컬럼이 무음으로 빠졌다.
 *
 * SQLite in-memory 실 SQL로 CREATE TABLE 경로를 검증한다.
 * 주의: SQLite의 PRAGMA table_info는 생성 컬럼을 숨기므로 table_xinfo로 검사한다.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ComputedColumn,
} from "../../../src";

describe("[Integration] SQLite: @ComputedColumn runtime synchronize", () => {
  let conn: TestConnectionResult;
  let OrderLine: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:" },
      () => {
        @Entity()
        class OrderLineEntity {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "int", nullable: false })
          qty!: number;

          @Column({ type: "int", nullable: false })
          price!: number;

          @ComputedColumn({ expression: "qty * price", type: "int" })
          total!: number;

          @ComputedColumn({
            expression: (e) => e.col("qty").add(1),
            type: "int",
            stored: true,
          })
          qtyPlusOne!: number;
        }
        OrderLine = OrderLineEntity;
        return { entities: [OrderLineEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("creates the generated columns as part of CREATE TABLE", async () => {
    const rows = await conn.em.query<any>(
      `PRAGMA table_xinfo("order_line_entity")`,
    );
    const cols = (Array.isArray(rows) ? rows : (rows as any).results ?? []).map(
      (r: any) => ({ name: r.name, hidden: r.hidden }),
    );
    const names = cols.map((c: any) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["id", "qty", "price", "total", "qtyPlusOne"]),
    );
    // hidden=2 → VIRTUAL (default), hidden=3 → STORED
    expect(cols.find((c: any) => c.name === "total")?.hidden).toBe(2);
    expect(cols.find((c: any) => c.name === "qtyPlusOne")?.hidden).toBe(3);
  });

  it("excludes generated columns from INSERT and computes their values", async () => {
    const saved: any = await conn.em.save(OrderLine, { qty: 3, price: 100 });
    expect(saved.id).toBeDefined();

    const raw = await conn.em.query<any>(
      `SELECT * FROM "order_line_entity" WHERE "id" = ${saved.id}`,
    );
    const row = (Array.isArray(raw) ? raw : (raw as any).results ?? [])[0];
    expect(row.total).toBe(300);
    expect(row.qtyPlusOne).toBe(4);
  });

  it("reads computed values through the SelectQueryBuilder (SELECT *)", async () => {
    const rows = await conn.em
      .createQueryBuilder(OrderLine, "o")
      .where("o.qty", 3)
      .getMany();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).total).toBe(300);
  });
});
