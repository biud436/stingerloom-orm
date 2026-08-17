/**
 * SQLite In-Memory: merge() of a detached instance carrying a @Version column.
 *
 * merge() seeds the tracked snapshot with a Symbol sentinel so every defined
 * column diffs as dirty (WriteBuffer.trackAsMergedDetached). That makes the
 * snapshot's version value a Symbol too, so FlushExecutor.ensureVersionIncrement
 * cannot compare it against the instance and never applies its manual bump —
 * the in-memory version then depends entirely on the write path's own
 * write-back. Nothing pinned that, so this suite guards the observable
 * contract: after a merge flush the row's version advanced by exactly one and
 * the instance agrees with the database.
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
  Version,
} from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

describe("[Integration] SQLite: buffer merge() with @Version", () => {
  let conn: TestConnectionResult;
  let Widget: any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("bufmergever");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: tableName })
        class WidgetEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
          @Version() version!: number;
        }

        Widget = WidgetEntity;
        return { entities: [WidgetEntity] };
      },
    );
  });

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  it("increments the version exactly once and keeps the instance in sync", async () => {
    const seeded: any = await conn.em.save(Widget, { name: "a" } as any);
    const seededVersion = seeded.version;
    expect(typeof seededVersion).toBe("number");

    const buf: WriteBuffer = (conn.em as any).buffer();
    const detached: any = new Widget();
    detached.id = seeded.id;
    detached.name = "b";
    detached.version = seededVersion;

    buf.merge(detached);
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const rows = (await conn.em.query(
      `SELECT "name", "version" FROM "${tableName}" WHERE "id" = ${seeded.id}`,
    )) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("b");
    expect(rows[0].version).toBe(seededVersion + 1);

    // The merged instance must not keep the stale version: a second merge with
    // it would fail the optimistic-lock WHERE and silently update 0 rows.
    expect(detached.version).toBe(seededVersion + 1);
  });

  it("supports a second merge of the same instance after the first flush", async () => {
    const seeded: any = await conn.em.save(Widget, { name: "x" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const detached: any = new Widget();
    detached.id = seeded.id;
    detached.name = "y";
    detached.version = seeded.version;

    buf.merge(detached);
    await buf.flush();

    detached.name = "z";
    buf.merge(detached);
    await buf.flush();

    const rows = (await conn.em.query(
      `SELECT "name", "version" FROM "${tableName}" WHERE "id" = ${seeded.id}`,
    )) as any[];
    expect(rows[0].name).toBe("z");
    expect(rows[0].version).toBe(seeded.version + 2);
  });
});
