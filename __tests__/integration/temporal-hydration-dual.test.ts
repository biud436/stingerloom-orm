/**
 * Temporal column hydration → Date, dual-driver mirror (V3-T1-1).
 *
 * pg / mysql2 already return Date at the driver, so the default temporal
 * read transform must be a pass-through there — these tests pin that the
 * SQLite fix introduced no behavior change on PostgreSQL/MySQL: plain
 * datetime columns hydrate as Date and round-trip the saved instant.
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { generateTableName } from "./helpers/create-test-entity";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

function createTemporalEntity() {
  const tableName = generateTableName("temporal");

  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  getScannerInstance(ColumnScanner).clear();

  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryGeneratedColumn()(DynamicClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "title");
  Column({ type: "varchar", length: 200 })(DynamicClass.prototype, "title");

  Reflect.defineMetadata("design:type", Date, DynamicClass.prototype, "publishedAt");
  Column({ type: "datetime", nullable: true })(DynamicClass.prototype, "publishedAt");

  Entity()(DynamicClass);

  return { EntityClass: DynamicClass, tableName };
}

describe.each(getTestDrivers())(
  "[Integration] Temporal hydration returns Date ($label)",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let entity: ReturnType<typeof createTemporalEntity>;

    afterEach(async () => {
      try {
        if (entity) await dropTestTable(entity.tableName);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    it("hydrates a plain datetime column as Date and round-trips the instant", async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entity = createTemporalEntity();
          return { entities: [entity.EntityClass] };
        },
      );

      const publishedAt = new Date("2026-08-05T13:06:11.000Z");
      const saved: any = await conn.em.save(entity.EntityClass, {
        title: "roundtrip",
        publishedAt,
      });

      const found: any = await conn.em.findOne(entity.EntityClass, {
        where: { id: saved.id },
      });

      expect(found).toBeDefined();
      expect(found.publishedAt).toBeInstanceOf(Date);
      expect(found.publishedAt.getTime()).toBe(publishedAt.getTime());
    }, 30000);

    it("leaves a null datetime column as null", async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entity = createTemporalEntity();
          return { entities: [entity.EntityClass] };
        },
      );

      const saved: any = await conn.em.save(entity.EntityClass, {
        title: "nulls",
      });

      const found: any = await conn.em.findOne(entity.EntityClass, {
        where: { id: saved.id },
      });

      expect(found.publishedAt ?? null).toBeNull();
    }, 30000);
  },
);
