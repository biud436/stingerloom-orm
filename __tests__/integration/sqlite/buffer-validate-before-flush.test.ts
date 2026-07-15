/**
 * SQLite In-Memory: WriteBuffer validateBeforeFlush against real SQL
 * (issue #404).
 *
 * Backfills the buffer-plugin.test.ts "validateBeforeFlush" describe, which
 * mocks em.transaction/em.save entirely — suppression of DB work on a
 * validation failure was proven only by "the save spy was not called", and
 * the happy path only by a mocked result counter. Zero integration coverage
 * existed for the option. A fail-open bug (invalid data persisted anyway) or
 * a fail-closed bug (valid entities silently dropped from the flush) would
 * both have passed. Here every claim is checked against real table state.
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
  NotNull,
  Min,
} from "../../../src";
import { ValidationError } from "../../../src/errors/ValidationError";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: WriteBuffer validateBeforeFlush", () => {
  let conn: TestConnectionResult;
  let VUser: any;
  const tableName = `vbf_user_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin({ validateBeforeFlush: true })],
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: tableName })
        class VUserEntity {
          @PrimaryGeneratedColumn() id!: number;
          @NotNull() @Column() name!: string;
          @Min(0) @Column({ type: "int" }) age!: number;
        }

        VUser = VUserEntity;
        return { entities: [VUserEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${tableName}"`);
  });

  async function rowCount(): Promise<number> {
    const rows = (await conn.em.query(
      `SELECT COUNT(*) AS c FROM "${tableName}"`,
    )) as any[];
    return Number(rows[0].c);
  }

  it("rejects an invalid persist and writes NOTHING to the table", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const ok = new VUser();
    ok.name = "valid";
    ok.age = 1;
    const bad = new VUser();
    bad.name = undefined; // @NotNull violation
    bad.age = 2;
    buf.persist(ok).persist(bad);

    await expect(buf.flush()).rejects.toThrow(ValidationError);

    // Validation aborts BEFORE any DB write — including the VALID sibling.
    expect(await rowCount()).toBe(0);
  });

  it("rejects a dirty tracked entity that became invalid and leaves the row unchanged", async () => {
    const seeded: any = await conn.em.save(VUser, { name: "a", age: 5 } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const loaded: any = await buf.findOne(VUser, { where: { id: seeded.id } as any });
    loaded.age = -1; // @Min(0) violation

    await expect(buf.flush()).rejects.toThrow(ValidationError);

    const rows = (await conn.em.query(
      `SELECT "age" FROM "${tableName}" WHERE "id" = ?`,
      [seeded.id],
    )) as any[];
    expect(rows[0].age).toBe(5);
  });

  it("persists everything when validation passes (no silent drop)", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const u1 = new VUser();
    u1.name = "alice";
    u1.age = 30;
    const u2 = new VUser();
    u2.name = "bob";
    u2.age = 0; // boundary: Min(0) inclusive
    buf.persist(u1).persist(u2);

    const result = await buf.flush();
    expect(result.inserts).toBe(2);

    const rows = (await conn.em.query(
      `SELECT "name", "age" FROM "${tableName}" ORDER BY "name"`,
    )) as any[];
    expect(rows).toEqual([
      { name: "alice", age: 30 },
      { name: "bob", age: 0 },
    ]);
  });

  it("a failed flush is retryable after the entity is fixed", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const u = new VUser();
    u.name = undefined; // invalid
    u.age = 1;
    buf.persist(u);
    await expect(buf.flush()).rejects.toThrow(ValidationError);

    u.name = "fixed";
    const result = await buf.flush();
    expect(result.inserts).toBe(1);
    expect(await rowCount()).toBe(1);
  });
});
