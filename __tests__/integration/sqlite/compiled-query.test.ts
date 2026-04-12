/**
 * SQLite In-Memory 사전 컴파일 쿼리 통합 테스트
 *
 * em.compile() / qb.prepare() 경로가 실제 DB 왕복에서 동일 결과를
 * 반복 실행 동안 돌려주는지, SQL 본문이 재조립되지 않는지 검증.
 */

import "reflect-metadata";
import sql from "sql-template-tag";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  p,
  CompiledQuery,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { SelectQueryBuilder } from "../../../src/core/SelectQueryBuilder";

function shortName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

async function setupProducts() {
  const tableName = shortName("cq_products");
  let ProductClass!: new () => any;

  const conn = await createTestConnection(
    {
      type: "sqlite",
      database: ":memory:",
      synchronize: false,
      logging: false,
    },
    () => {
      getScannerInstance(ColumnScanner).clear();
      const P = class {} as any;
      Object.defineProperty(P, "name", { value: tableName, writable: false });

      Reflect.defineMetadata("design:type", Number, P.prototype, "id");
      PrimaryGeneratedColumn()(P.prototype, "id");

      Reflect.defineMetadata("design:type", String, P.prototype, "name");
      Column()(P.prototype, "name");

      Reflect.defineMetadata("design:type", Number, P.prototype, "price");
      Column({ type: "int" })(P.prototype, "price");

      Entity()(P);
      ProductClass = P;
      return { entities: [P] };
    },
  );

  const connector = DatabaseClient.getInstance().getConnection();
  await connector.query(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "price" INTEGER NOT NULL
    )
  `);

  return { conn, ProductClass, tableName };
}

describe("[Integration] SQLite: Compiled Query", () => {
  let conn: TestConnectionResult;
  let Product: new () => any;

  beforeAll(async () => {
    const setup = await setupProducts();
    conn = setup.conn;
    Product = setup.ProductClass;

    const { em } = conn;
    await em.save(Product, { name: "Pen", price: 100 } as any);
    await em.save(Product, { name: "Pencil", price: 50 } as any);
    await em.save(Product, { name: "Eraser", price: 30 } as any);
    await em.save(Product, { name: "Ruler", price: 200 } as any);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("SelectQueryBuilder.prepare() returns identical rows on repeated execute()", async () => {
    const { em } = conn;
    const qb = new SelectQueryBuilder(Product, "p", em).where(
      sql`p.price >= ${p("min")}`,
    );
    const compiled = qb.prepare<{ min: number }>();

    const firstSql = compiled.sql;
    const expensive = await compiled.execute({ min: 100 });
    const cheap = await compiled.execute({ min: 40 });
    const reallyCheap = await compiled.execute({ min: 10 });

    expect(compiled.sql).toBe(firstSql);
    expect(expensive.map((r: any) => r.name).sort()).toEqual(["Pen", "Ruler"]);
    expect(cheap.map((r: any) => r.name).sort()).toEqual([
      "Pen",
      "Pencil",
      "Ruler",
    ]);
    expect(reallyCheap.length).toBe(4);
  });

  it("em.compile() wires placeholders through a proxy", async () => {
    const { em } = conn;

    const findByName = em.compile<{ id: number; name: string }, { name: string }>(
      (em, $) =>
        new SelectQueryBuilder(Product, "p", em).where(
          sql`p.name = ${$.name}`,
        ),
    );

    expect(findByName).toBeInstanceOf(CompiledQuery);
    expect([...findByName.parameterNames]).toEqual(["name"]);

    const pen = await findByName.executeOne({ name: "Pen" });
    const pencil = await findByName.executeOne({ name: "Pencil" });
    const none = await findByName.executeOne({ name: "Stapler" });

    expect(pen?.name).toBe("Pen");
    expect(pencil?.name).toBe("Pencil");
    expect(none).toBeNull();
  });

  it("deserializes compiled rows into entity instances", async () => {
    const { em } = conn;
    const compiled = new SelectQueryBuilder(Product, "p", em)
      .where(sql`p.price = ${p("price")}`)
      .prepare<{ price: number }>();

    const rows = await compiled.execute({ price: 100 });
    expect(rows.length).toBe(1);
    expect(rows[0]).toBeInstanceOf(Product);
    expect((rows[0] as any).name).toBe("Pen");
  });

  it("RawQueryBuilder.prepare() surfaces raw rows", async () => {
    const { em, options } = conn;
    void options;
    const qb = em
      .createQueryBuilder()
      .select(["name", "price"])
      .from((Product as any).name)
      .where([sql`price > ${p("min")}`]);
    const compiled = qb.prepare<{ name: string; price: number }, { min: number }>(
      em as any,
    );

    const rows = await compiled.execute({ min: 40 });
    expect(rows.map((r) => r.name).sort()).toEqual(["Pen", "Pencil", "Ruler"]);
  });
});
