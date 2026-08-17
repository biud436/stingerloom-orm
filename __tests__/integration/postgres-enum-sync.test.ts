/**
 * PostgreSQL (real server): `type: "enum"` 컬럼의 synchronize 동기화 E2E.
 *
 * PG의 enum 컬럼은 명명 타입(`"schema"."tbl_col_enum"`)을 참조하므로
 * CREATE TABLE / ADD COLUMN 이전에 CREATE TYPE이 선행되어야 하고,
 * 값이 추가되면 ALTER TYPE ... ADD VALUE가 필요합니다.
 *
 * 검증 시나리오:
 *  1. enum 컬럼을 가진 신규 테이블을 synchronize:true 부팅이 실제로 생성
 *  2. 기존 enum 타입에 값이 추가되면 재부팅이 ALTER TYPE ADD VALUE 반영
 *  3. 기존 테이블에 enum 컬럼이 추가되면 CREATE TYPE + ADD COLUMN 수행
 *
 * Run:
 *   INTEGRATION_TEST=true PG_HOST=192.168.35.227 \
 *     npx jest --testPathPattern="postgres-enum-sync"
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { Logger } from "../../src/utils/Logger";

const INTEGRATION =
  process.env.INTEGRATION_TEST === "true" &&
  process.env.INTEGRATION_TEST_POSTGRES !== "false";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

const PG_BASE: Partial<DatabaseClientOptions> = {
  type: "postgres",
  host: process.env.PG_HOST || "192.168.35.227",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

const SFX = String(Date.now()).slice(-7);
const T_NEW = `enum_new_${SFX}`;
const T_ADD_VALUE = `enum_val_${SFX}`;
const T_ADD_COL = `enum_col_${SFX}`;
const E_ADD_VALUE = `${T_ADD_VALUE}_status_enum`;

async function enumLabels(enumName: string): Promise<string[]> {
  const rows = (await rawQuery(
    `SELECT e.enumlabel FROM pg_type t
       JOIN pg_enum e ON t.oid = e.enumtypid
       JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE t.typname = '${enumName}' AND n.nspname = 'public'
      ORDER BY e.enumsortorder`,
  )) as Array<{ enumlabel: string }>;
  return rows.map((r) => r.enumlabel);
}

async function columnTypes(
  table: string,
): Promise<Record<string, { data_type: string; udt_name: string }>> {
  const cols = (await rawQuery(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_name = '${table}' AND table_schema = 'public'
      ORDER BY ordinal_position`,
  )) as Array<{ column_name: string; data_type: string; udt_name: string }>;
  return Object.fromEntries(
    cols.map((c) => [
      c.column_name,
      { data_type: c.data_type, udt_name: c.udt_name },
    ]),
  );
}

/** Logger 출력을 가로채 부팅 중 실행된 DDL 로그를 관찰합니다. */
function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  Logger.reset();
  Logger.setOutput((message) => lines.push(message));
  return { lines, stop: () => Logger.reset() };
}

integrationDescribe("[Integration][Postgres] enum synchronize", () => {
  describe("신규 테이블의 enum 컬럼", () => {
    let conn: TestConnectionResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, synchronize: true, logging: false },
        () => {
          @Entity({ name: T_NEW })
          class EnumNewEntity {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({
              type: "enum",
              enumValues: ["draft", "published", "archived"],
            })
            status!: string;
          }
          return { entities: [EnumNewEntity] };
        },
      );
    });

    afterAll(async () => {
      await dropTestTable(T_NEW);
      await rawQuery(
        `DROP TYPE IF EXISTS "public"."${T_NEW}_status_enum" CASCADE`,
      ).catch(() => undefined);
      await conn.cleanup();
    });

    it("CREATE TYPE + CREATE TABLE이 실행되어야 함", async () => {
      const labels = await enumLabels(`${T_NEW}_status_enum`);
      expect(labels).toEqual(["draft", "published", "archived"]);

      const cols = await columnTypes(T_NEW);
      expect(cols["status"]).toMatchObject({
        data_type: "USER-DEFINED",
        udt_name: `${T_NEW}_status_enum`,
      });
    });

    it("enum 값이 save → find로 왕복되어야 함", async () => {
      const rows = (await rawQuery(
        `INSERT INTO "${T_NEW}" ("status") VALUES ('published') RETURNING id, status`,
      )) as Array<{ id: number; status: string }>;
      expect(rows[0].status).toBe("published");
    });

    it("변경 없는 재부팅은 enum DDL을 실행하지 않아야 함", async () => {
      const before = await enumLabels(`${T_NEW}_status_enum`);
      await conn.cleanup();

      const captured = captureLogs();
      try {
        // logDDL: true — 실행되는 DDL은 전부 로그로 드러난다.
        conn = await createTestConnection(
          {
            ...PG_BASE,
            synchronize: { mode: true, logDDL: true },
            logging: false,
          },
          () => {
            @Entity({ name: T_NEW })
            class EnumNewAgainEntity {
              @PrimaryGeneratedColumn()
              id!: number;

              @Column({
                type: "enum",
                enumValues: ["draft", "published", "archived"],
              })
              status!: string;
            }
            return { entities: [EnumNewAgainEntity] };
          },
        );
      } finally {
        captured.stop();
      }

      expect(await enumLabels(`${T_NEW}_status_enum`)).toEqual(before);
      const enumDdl = captured.lines.filter(
        (l) => l.includes("CREATE TYPE") || l.includes("ALTER TYPE"),
      );
      expect(enumDdl).toEqual([]);
      expect(captured.lines.filter((l) => l.includes("WARN"))).toEqual([]);
    });
  });

  describe("기존 enum 타입에 값 추가", () => {
    let conn: TestConnectionResult;

    beforeAll(async () => {
      // 값 2개짜리 enum 타입 + 테이블을 먼저 만들어 둔다.
      const bootstrap = await createTestConnection({
        ...PG_BASE,
        synchronize: false,
        logging: false,
        entities: [],
      });
      await rawQuery(
        `DROP TABLE IF EXISTS "${T_ADD_VALUE}" CASCADE`,
      ).catch(() => undefined);
      await rawQuery(`DROP TYPE IF EXISTS "${E_ADD_VALUE}" CASCADE`).catch(
        () => undefined,
      );
      await rawQuery(
        `CREATE TYPE "${E_ADD_VALUE}" AS ENUM ('draft', 'published')`,
      );
      await rawQuery(
        `CREATE TABLE "${T_ADD_VALUE}" ("id" SERIAL NOT NULL PRIMARY KEY, "status" "${E_ADD_VALUE}" NOT NULL)`,
      );
      await bootstrap.cleanup();

      // 엔티티는 값 3개 — 재부팅이 ALTER TYPE ADD VALUE를 실행해야 한다.
      // 새 값 "archived"는 선언 순서상 가운데라, 정렬 순서를 유지하려면
      // 끝에 덧붙이지 않고 "published" 앞에 삽입되어야 한다.
      conn = await createTestConnection(
        { ...PG_BASE, synchronize: true, logging: false },
        () => {
          @Entity({ name: T_ADD_VALUE })
          class EnumValueEntity {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({
              type: "enum",
              enumValues: ["draft", "archived", "published"],
            })
            status!: string;
          }
          return { entities: [EnumValueEntity] };
        },
      );
    });

    afterAll(async () => {
      await dropTestTable(T_ADD_VALUE);
      await rawQuery(`DROP TYPE IF EXISTS "${E_ADD_VALUE}" CASCADE`).catch(
        () => undefined,
      );
      await conn.cleanup();
    });

    it("추가된 값이 선언 순서를 지켜 pg_enum에 반영되어야 함", async () => {
      const labels = await enumLabels(E_ADD_VALUE);
      expect(labels).toEqual(["draft", "archived", "published"]);
    });

    it("새 값을 실제로 INSERT할 수 있어야 함", async () => {
      const rows = (await rawQuery(
        `INSERT INTO "${T_ADD_VALUE}" ("status") VALUES ('archived') RETURNING status`,
      )) as Array<{ status: string }>;
      expect(rows[0].status).toBe("archived");
    });
  });

  describe("기존 테이블에 enum 컬럼 추가", () => {
    let conn: TestConnectionResult;

    beforeAll(async () => {
      const bootstrap = await createTestConnection({
        ...PG_BASE,
        synchronize: false,
        logging: false,
        entities: [],
      });
      await rawQuery(`DROP TABLE IF EXISTS "${T_ADD_COL}" CASCADE`).catch(
        () => undefined,
      );
      await rawQuery(
        `DROP TYPE IF EXISTS "${T_ADD_COL}_status_enum" CASCADE`,
      ).catch(() => undefined);
      await rawQuery(
        `CREATE TABLE "${T_ADD_COL}" ("id" SERIAL NOT NULL PRIMARY KEY)`,
      );
      await bootstrap.cleanup();

      conn = await createTestConnection(
        { ...PG_BASE, synchronize: true, logging: false },
        () => {
          @Entity({ name: T_ADD_COL })
          class EnumColumnEntity {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({
              type: "enum",
              enumValues: ["low", "high"],
              nullable: true,
            })
            status!: string | null;
          }
          return { entities: [EnumColumnEntity] };
        },
      );
    });

    afterAll(async () => {
      await dropTestTable(T_ADD_COL);
      await rawQuery(
        `DROP TYPE IF EXISTS "${T_ADD_COL}_status_enum" CASCADE`,
      ).catch(() => undefined);
      await conn.cleanup();
    });

    it("CREATE TYPE + ADD COLUMN이 실행되어야 함", async () => {
      const labels = await enumLabels(`${T_ADD_COL}_status_enum`);
      expect(labels).toEqual(["low", "high"]);

      const cols = await columnTypes(T_ADD_COL);
      expect(cols["status"]).toMatchObject({
        data_type: "USER-DEFINED",
        udt_name: `${T_ADD_COL}_status_enum`,
      });
    });
  });
});
