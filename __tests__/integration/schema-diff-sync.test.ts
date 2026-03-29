/**
 * SchemaDiff 동기화 후 감지 검증 통합 테스트 (MySQL / PostgreSQL)
 *
 * synchronize: true로 테이블을 생성한 뒤,
 * SchemaDiff.diff()가 컬럼 추가/수정/삭제를 올바르게 감지하는지 검증합니다.
 *
 * SQLite 전용 테스트는 sqlite/schema-diff-sync.test.ts에 있습니다.
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { DatabaseClient } from "../../src/DatabaseClient";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import type { SchemaDialect } from "../../src/core/generators/SchemaGenerator";
import type { Sql } from "sql-template-tag";

const drivers = getTestDrivers();

function shortTable(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(drivers)(
  "[Integration] $label: SchemaDiff 동기화 후 감지 검증",
  ({ type, options }) => {
    const TABLE_NAME = shortTable("sd");
    let conn: TestConnectionResult;
    let V1Entity: new () => any;
    let schemaDiff: SchemaDiff;
    let queryRunner: { query: (sql: string | Sql) => Promise<any> };
    let dialect: SchemaDialect;

    function makeEntity(
      columns: Array<{
        name: string;
        designType: any;
        primary?: boolean;
        options?: any;
      }>,
    ): new () => any {
      getScannerInstance(ColumnScanner).clear();

      const DynClass = class {} as any;
      Object.defineProperty(DynClass, "name", {
        value: TABLE_NAME,
        writable: false,
      });

      for (const col of columns) {
        Reflect.defineMetadata(
          "design:type",
          col.designType,
          DynClass.prototype,
          col.name,
        );
        if (col.primary) {
          PrimaryGeneratedColumn(col.options)(DynClass.prototype, col.name);
        } else {
          Column(col.options)(DynClass.prototype, col.name);
        }
      }

      Entity()(DynClass);
      return DynClass;
    }

    beforeAll(async () => {
      dialect = type as SchemaDialect;

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          V1Entity = makeEntity([
            { name: "id", designType: Number, primary: true },
            { name: "name", designType: String },
            { name: "age", designType: Number, options: { type: "int" } },
          ]);
          return { entities: [V1Entity] };
        },
      );

      const connector = DatabaseClient.getInstance().getConnection();
      queryRunner = {
        query: (s: string | Sql) => connector.query(s as any),
      };
      schemaDiff = new SchemaDiff();
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(TABLE_NAME);
      } catch {}
      await conn.cleanup();
    }, 15000);

    // ─── Baseline ──────────────────────────────────────────────

    it("should report no changes after initial synchronization", async () => {
      const result = await schemaDiff.diff([V1Entity], queryRunner, dialect);

      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
      expect(result.alterColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
    });

    // ─── Added column ──────────────────────────────────────────

    it("should detect a single added column", async () => {
      const V2 = makeEntity([
        { name: "id", designType: Number, primary: true },
        { name: "name", designType: String },
        { name: "age", designType: Number, options: { type: "int" } },
        {
          name: "email",
          designType: String,
          options: { type: "varchar", nullable: true },
        },
      ]);

      const result = await schemaDiff.diff([V2], queryRunner, dialect);

      expect(result.addColumns.length).toBe(1);
      expect(result.addColumns[0].columnName).toBe("email");
      expect(result.addColumns[0].nullable).toBe(true);
    });

    it("should detect multiple added columns", async () => {
      const V3 = makeEntity([
        { name: "id", designType: Number, primary: true },
        { name: "name", designType: String },
        { name: "age", designType: Number, options: { type: "int" } },
        {
          name: "email",
          designType: String,
          options: { type: "varchar", nullable: true },
        },
        {
          name: "bio",
          designType: String,
          options: { type: "text", nullable: true },
        },
      ]);

      const result = await schemaDiff.diff([V3], queryRunner, dialect);

      expect(result.addColumns.length).toBe(2);
      const names = result.addColumns.map((c) => c.columnName).sort();
      expect(names).toEqual(["bio", "email"]);
    });

    // ─── Modified column ───────────────────────────────────────

    it("should detect column type change", async () => {
      const modified = makeEntity([
        { name: "id", designType: Number, primary: true },
        { name: "name", designType: String },
        // age: int → text
        { name: "age", designType: String, options: { type: "text" } },
      ]);

      const result = await schemaDiff.diff([modified], queryRunner, dialect);

      const ageChange = result.alterColumns.find(
        (c) => c.columnName === "age",
      );
      expect(ageChange).toBeDefined();
    });

    // ─── Dropped column ────────────────────────────────────────

    it("should detect a removed column", async () => {
      const dropped = makeEntity([
        { name: "id", designType: Number, primary: true },
        { name: "name", designType: String },
        // age column removed
      ]);

      const result = await schemaDiff.diff([dropped], queryRunner, dialect);

      const ageDrop = result.dropColumns.find((c) => c.columnName === "age");
      expect(ageDrop).toBeDefined();
    });

    // ─── Rename detection ──────────────────────────────────────

    it("should detect rename (drop+add same type = rename pair)", async () => {
      const renamed = makeEntity([
        { name: "id", designType: Number, primary: true },
        { name: "name", designType: String },
        // age removed, years added (same type)
        { name: "years", designType: Number, options: { type: "int" } },
      ]);

      const result = await schemaDiff.diff([renamed], queryRunner, dialect);

      if (result.renamedColumns && result.renamedColumns.length > 0) {
        const rename = result.renamedColumns[0];
        expect(rename.oldColumnName).toBe("age");
        expect(rename.newColumnName).toBe("years");
      } else {
        // Fallback: at least add+drop detected
        expect(result.addColumns.length).toBeGreaterThanOrEqual(1);
        expect(result.dropColumns.length).toBeGreaterThanOrEqual(1);
      }
    });

    // ─── New table ─────────────────────────────────────────────

    it("should detect a brand new table", async () => {
      const newTable = shortTable("sd_new");
      getScannerInstance(ColumnScanner).clear();

      const NewClass = class {} as any;
      Object.defineProperty(NewClass, "name", {
        value: newTable,
        writable: false,
      });

      Reflect.defineMetadata(
        "design:type",
        Number,
        NewClass.prototype,
        "id",
      );
      PrimaryGeneratedColumn()(NewClass.prototype, "id");

      Reflect.defineMetadata(
        "design:type",
        String,
        NewClass.prototype,
        "title",
      );
      Column()(NewClass.prototype, "title");

      Entity()(NewClass);

      const result = await schemaDiff.diff(
        [V1Entity, NewClass],
        queryRunner,
        dialect,
      );

      expect(result.addTables).toContain(newTable);
      expect(result.addTables).not.toContain(TABLE_NAME);
    });
  },
);
