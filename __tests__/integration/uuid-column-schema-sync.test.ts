/**
 * uuid 컬럼 선언 타입 라운드트립 — MySQL/MariaDB + PostgreSQL (V6-T1-3)
 *
 * 검증 내용:
 * 1. 기존 테이블에 `@Column({ type: "uuid" })`가 추가되면 ADD COLUMN이
 *    CREATE TABLE과 같은 타입을 쓴다. 수정 전 MySQL 경로는 길이 없는 `CHAR`
 *    (= CHAR(1))를 발행해서 strict 모드에선 INSERT가 죽고, 아니면 한 글자로
 *    잘렸다.
 * 2. 36자 UUID 값이 손실 없이 왕복한다.
 * 3. 재부팅 diff가 같은 컬럼을 드리프트로 보지 않는다 (MariaDB 10.7+의 네이티브
 *    UUID는 수정 전 매 부팅 `MODIFY COLUMN ... CHAR` 대상이었다).
 *
 * 실행:
 *   INTEGRATION_TEST=true npx jest --testPathPattern "uuid-column-schema-sync"
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";
import { generateTableName } from "./helpers/create-test-entity";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { createColumnDefinitionBuilder } from "../../src/dialects/ColumnDefinitionBuilder";

const SKIP = process.env.INTEGRATION_TEST !== "true";
const SAMPLE_UUID = "0192f0c4-7b1e-7c2a-9f3d-2b8a1c4e5d60";

(SKIP ? describe.skip : describe).each(getTestDrivers())(
  "[Integration] uuid column schema sync ($label)",
  ({ type, options }: TestDriverConfig) => {
    const tableName = generateTableName("uuid_sync");
    let conn: TestConnectionResult | undefined;

    function rows(result: any): any[] {
      const rs = result?.results ?? result?.rows ?? result;
      return Array.isArray(rs) ? rs : [];
    }

    /** DATA_TYPE / CHARACTER_MAXIMUM_LENGTH straight from the catalog. */
    async function columnInfo(
      column: string,
    ): Promise<{ dataType: string; length: number | null }> {
      const sql =
        type === "mysql"
          ? `SELECT DATA_TYPE AS data_type, CHARACTER_MAXIMUM_LENGTH AS len
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tableName}'
               AND COLUMN_NAME = '${column}'`
          : `SELECT data_type, character_maximum_length AS len
             FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = '${tableName}'
               AND column_name = '${column}'`;
      const found = rows(await rawQuery(sql));
      expect(found).toHaveLength(1);
      const len = found[0].len ?? found[0].LEN ?? null;
      return {
        dataType: String(found[0].data_type ?? found[0].DATA_TYPE).toLowerCase(),
        length: len === null ? null : Number(len),
      };
    }

    function defineV1(): any {
      @Entity({ name: tableName })
      class UuidSyncV1 {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 40 })
        label!: string;
      }
      return UuidSyncV1;
    }

    function defineV2(): any {
      @Entity({ name: tableName })
      class UuidSyncV2 {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 40 })
        label!: string;

        @Column({ type: "uuid", nullable: true })
        publicId!: string;
      }
      return UuidSyncV2;
    }

    afterEach(async () => {
      if (conn) {
        await conn.cleanup();
        conn = undefined;
      }
    });

    afterAll(async () => {
      const last = await createTestConnection({
        synchronize: false,
        logging: false,
        ...options,
        entities: [],
      });
      try {
        await dropTestTable(tableName);
      } finally {
        await last.cleanup();
      }
    }, 15000);

    it("adds a uuid column with the type CREATE TABLE would have given it, and round-trips 36 characters", async () => {
      // Boot 1: no uuid column yet.
      let V1: any;
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          V1 = defineV1();
          return { entities: [V1] };
        },
      );
      await conn.em.save(V1, { label: "before" });
      await conn.cleanup();
      conn = undefined;

      // Boot 2: the entity now declares the uuid column — ADD COLUMN runs.
      let V2: any;
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          V2 = defineV2();
          return { entities: [V2] };
        },
      );

      const info = await columnInfo("publicId");
      if (type === "postgres") {
        expect(info.dataType).toBe("uuid");
      } else if (info.dataType === "uuid") {
        // MariaDB 10.7+ native UUID: 16 bytes, no character length.
        expect(info.length).toBeNull();
      } else {
        expect(info.dataType).toBe("char");
        // The defect: a bare `CHAR` is CHAR(1) on MySQL.
        expect(info.length).toBe(36);
      }

      const saved: any = await conn.em.save(V2, {
        label: "after",
        publicId: SAMPLE_UUID,
      });
      const found: any = await conn.em.findOne(V2, {
        where: { id: saved.id },
      });
      expect(String(found.publicId).toLowerCase()).toBe(SAMPLE_UUID);
    }, 40000);

    it("reports no drift for the uuid column on the next boot", async () => {
      let V2: any;
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          V2 = defineV2();
          return { entities: [V2] };
        },
      );

      const driver = conn.em.getDriver();
      const diff = await new SchemaDiff().diff(
        [V2],
        { query: (s: any) => rawQuery(s) },
        type === "mysql" ? "mysql" : "postgres",
        undefined,
        {
          columnBuilder: createColumnDefinitionBuilder(
            type === "mysql" ? "mysql" : "postgres",
            undefined,
            driver?.getCapabilities?.(),
          ),
        },
      );

      expect(diff.alterColumns).toHaveLength(0);
      expect(diff.addColumns).toHaveLength(0);
      expect(diff.dropColumns).toHaveLength(0);

      // The value written on the previous boot survived a synchronize pass.
      const all: any[] = await conn.em.find(V2, {});
      const withUuid = all.find((r) => r.publicId);
      expect(String(withUuid.publicId).toLowerCase()).toBe(SAMPLE_UUID);
    }, 40000);
  },
);
