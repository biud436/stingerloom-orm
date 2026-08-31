/**
 * Every write path must persist the same instant, dual-driver mirror.
 *
 * The SQLite suite (integration/sqlite/temporal-write-consistency.test.ts)
 * pins the stored text format. This one pins the part that matters on a real
 * server: the instant itself. Before the fix, the batch paths sent a zone-less
 * local wall-clock string, so PostgreSQL resolved it with the server's
 * TimeZone setting and stored a different instant than `save()` did for the
 * very same Date — invisible whenever the application process and the server
 * happened to share a zone.
 *
 * Fail-before, measured against a server whose TimeZone is Asia/Seoul: with
 * the process in America/New_York, `insertMany` stored 2026-02-28T22:34:56Z
 * for a source instant of 2026-03-01T12:34:56Z (14 hours out) while `save()`
 * stored it correctly. With process and server in the same zone the old code
 * round-trips, so this suite only exercises the defect when the two differ —
 * it is a cross-path instant pin in every environment either way.
 *
 * MySQL/MariaDB cannot fail this the same way (no zone-aware DATETIME, so
 * both encodings resolve in the connection timezone); the driver runs here as
 * a no-regression check.
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { generateTableName } from "./helpers/create-test-entity";
import { Entity, Column, PrimaryColumn } from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

function createEventEntity() {
  const tableName = generateTableName("twcd");

  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  getScannerInstance(ColumnScanner).clear();

  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryColumn({ type: "int" })(DynamicClass.prototype, "id");

  Reflect.defineMetadata(
    "design:type",
    Date,
    DynamicClass.prototype,
    "occurredAt",
  );
  // timestamptz is the type that exposes the defect: PostgreSQL resolves a
  // zone-less string with the SERVER TimeZone, while a bound Date carries the
  // instant. A plain `datetime` column hides it, because pg writes and reads
  // `timestamp without time zone` with the same local interpretation.
  Column({ type: "timestamptz" })(DynamicClass.prototype, "occurredAt");

  Entity()(DynamicClass);

  return { EntityClass: DynamicClass, tableName };
}

/**
 * A source instant whose local wall time differs from its UTC wall time in
 * every non-UTC process timezone — the case the old formatter got wrong.
 */
const SOURCE = new Date("2026-03-01T12:34:56.000Z");

describe.each(getTestDrivers())(
  "[Integration] Temporal write consistency across paths ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let entity: ReturnType<typeof createEventEntity>;

    afterEach(async () => {
      try {
        if (entity) await dropTestTable(entity.tableName);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    it("stores the same instant through save, insertMany and batchUpsert", async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entity = createEventEntity();
          return { entities: [entity.EntityClass] };
        },
      );

      const { em } = conn;
      const E = entity.EntityClass;

      // insertManyAndReturn needs INSERT ... RETURNING, which MySQL lacks.
      const supportsReturning = type !== "mysql";

      const labels = ["save", "insertMany"];
      await em.save(E, { id: 1, occurredAt: SOURCE } as never);
      await em.insertMany(E, [{ id: 2, occurredAt: SOURCE }] as never);
      if (supportsReturning) {
        await em.insertManyAndReturn(E, [
          { id: 3, occurredAt: SOURCE },
        ] as never);
        labels.push("insertManyAndReturn");
      }
      await em.batchUpsert(
        E,
        [{ id: supportsReturning ? 4 : 3, occurredAt: SOURCE }] as never,
        ["id"],
      );
      labels.push("batchUpsert");

      const rows: any[] = await em.find(E, { orderBy: { id: "ASC" } } as never);
      expect(rows).toHaveLength(labels.length);
      for (const row of rows) {
        const label = labels[row.id - 1];
        expect(row.occurredAt).toBeInstanceOf(Date);
        // Compared at second granularity: a MySQL DATETIME column without
        // declared fractional precision drops milliseconds server-side, which
        // is a schema property rather than a serialization defect.
        expect(`${label}: ${row.occurredAt.toISOString()}`).toBe(
          `${label}: ${SOURCE.toISOString()}`,
        );
      }
    }, 30000);
  },
);
