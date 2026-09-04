/**
 * @ComputedColumn 런타임 synchronize 통합 테스트 — MySQL / PostgreSQL (V5-T0-3)
 *
 * 검증 내용:
 * 1. synchronize: true 부팅이 GENERATED ALWAYS AS 컬럼을 실제로 생성한다
 *    (수정 전에는 migrate:generate 전용이라 무음으로 빠졌다).
 * 2. find/findOne이 계산값을 하이드레이션한다 (수정 전 무음 undefined).
 * 3. 재부팅 시 SchemaDiff가 DB의 생성 컬럼을 드롭 후보로 오인하지 않는다
 *    (수정 전 MySQL/PostgreSQL에서 synchronize: true가 컬럼을 DROP했다).
 * 4. 기존 테이블에 새로 선언된 계산 컬럼이 ALTER TABLE ADD COLUMN으로 추가된다.
 *
 * PostgreSQL은 STORED만 지원하므로 VIRTUAL 요청은 STORED로 강제된다.
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import { generateTableName } from "./helpers/create-test-entity";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ComputedColumn,
} from "../../src";

const SKIP = process.env.INTEGRATION_TEST !== "true";

(SKIP ? describe.skip : describe).each(getTestDrivers())(
  "[Integration] @ComputedColumn runtime synchronize ($label)",
  ({ options }: TestDriverConfig) => {
    const tableName = generateTableName("computed_sync");
    const diffTableName = generateTableName("computed_diff");
    let conn: TestConnectionResult | undefined;

    function defineFullEntity() {
      @Entity({ name: tableName })
      class ComputedSyncLine {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "int", nullable: false })
        qty!: number;

        @Column({ type: "int", nullable: false })
        price!: number;

        @ComputedColumn({ expression: "qty * price", type: "int" })
        total!: number;
      }
      return ComputedSyncLine;
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
        await dropTestTable(diffTableName);
      } finally {
        await last.cleanup();
      }
    }, 15000);

    it("creates the generated column at boot and hydrates it through find", async () => {
      let EntityClass: any;
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          EntityClass = defineFullEntity();
          return { entities: [EntityClass] };
        },
      );

      const saved: any = await conn.em.save(EntityClass, { qty: 3, price: 100 });
      expect(saved.id).toBeDefined();

      const found: any = await conn.em.findOne(EntityClass, {
        where: { id: saved.id },
      });
      expect(found.total).toBe(300);

      const filtered: any[] = await conn.em.find(EntityClass, {
        where: { total: 300 } as any,
      });
      expect(filtered).toHaveLength(1);
    }, 30000);

    it("keeps the generated column across reboots (no DROP, no duplicate ADD)", async () => {
      let EntityClass: any;
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          EntityClass = defineFullEntity();
          return { entities: [EntityClass] };
        },
      );

      const found: any = await conn.em.findOne(EntityClass, {
        where: { total: 300 } as any,
      });
      expect(found).not.toBeNull();
      expect(found.total).toBe(300);
    }, 30000);

    it("adds a newly declared computed column to an existing table", async () => {
      // Boot 1: no computed column.
      let V1: any;
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: diffTableName })
          class ComputedDiffV1 {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "int", nullable: false })
            qty!: number;
          }
          V1 = ComputedDiffV1;
          return { entities: [ComputedDiffV1] };
        },
      );
      await conn.em.save(V1, { qty: 7 });
      await conn.cleanup();
      conn = undefined;

      // Boot 2: the entity now declares a computed column — the diff pass
      // must ADD COLUMN it, and the pre-existing row must compute a value.
      let V2: any;
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: diffTableName })
          class ComputedDiffV2 {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "int", nullable: false })
            qty!: number;

            @ComputedColumn({ expression: "qty * 10", type: "int" })
            scaled!: number;
          }
          V2 = ComputedDiffV2;
          return { entities: [ComputedDiffV2] };
        },
      );
      const rows: any[] = await conn.em.find(V2, {});
      expect(rows).toHaveLength(1);
      expect(rows[0].scaled).toBe(70);
    }, 30000);
  },
);
