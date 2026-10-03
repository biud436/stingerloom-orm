/**
 * @ComputedColumn runtime synchronize integration tests — MySQL / PostgreSQL
 *
 * Covered:
 * 1. A synchronize: true boot actually creates the GENERATED ALWAYS AS column
 *    (before the fix it was migrate:generate-only and silently skipped).
 * 2. find/findOne hydrate the computed value (silently undefined before the fix).
 * 3. On reboot, SchemaDiff does not mistake the DB's generated column for a drop candidate
 *    (before the fix, synchronize: true DROPped the column on MySQL/PostgreSQL).
 * 4. A computed column newly declared on an existing table is added with ALTER TABLE ADD COLUMN.
 *
 * PostgreSQL only supports STORED, so a VIRTUAL request is forced to STORED.
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
