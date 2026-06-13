/**
 * SQLite In-Memory: @Version increment on criteria-based updateMany()/update().
 *
 * Verifies that a criteria-based update bumps the optimistic-lock counter the
 * same way save() does, so a later save() carrying a now-stale version is
 * rejected.
 *
 * NOTE: SQLite's session does not surface a `rowCount`, so the rigorous
 * "increment SQL is emitted only when appropriate" assertions live in the unit
 * suite (update-many-version.test.ts). Here we observe the persisted version
 * value directly, which is unaffected by that limitation.
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
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { OptimisticLockError } from "../../../src/errors/OptimisticLockError";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

describe("[Integration] SQLite: updateMany() @Version increment", () => {
  let conn: TestConnectionResult;
  let Doc: any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("ver_doc");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        clearScanners();

        @Entity({ name: tableName })
        class DocEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          @Version() version!: number;
        }

        Doc = DocEntity;
        return { entities: [DocEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("em.update() bumps the version, and a later stale-version save is rejected", async () => {
    // 1. INSERT initializes version to 1.
    const doc: any = await conn.em.save(Doc, { title: "A" });
    expect(doc.version).toBe(1);

    // 2. Criteria-based update must bump the version (the fix).
    await conn.em.update(Doc, { id: doc.id } as any, { title: "B" } as any);

    const connector = DatabaseClient.getInstance().getConnection();
    const rows = await connector.query(
      `SELECT "version", "title" FROM "${tableName}" WHERE "id" = ${doc.id}`,
    );
    expect(rows[0].version).toBe(2);
    expect(rows[0].title).toBe("B");

    // 3. A save() holding the original (now stale) version is rejected.
    await expect(
      conn.em.save(Doc, { id: doc.id, title: "C", version: 1 } as any),
    ).rejects.toBeInstanceOf(OptimisticLockError);
  });

  it("save() update carrying the CURRENT version succeeds (no false optimistic-lock)", async () => {
    // Regression for the SqliteConnector rowCount fix: the @Version save path
    // throws OptimisticLockError when the UPDATE matches 0 rows (affected === 0).
    // Before SQLite exposed rowCount, affected was ALWAYS 0, so even a correct
    // version threw. Insert (version 1), then save() an update carrying the
    // current version 1 — it must SUCCEED and bump the version to 2.
    const doc: any = await conn.em.save(Doc, { title: "fresh" });
    expect(doc.version).toBe(1);

    const updated: any = await conn.em.save(Doc, {
      id: doc.id,
      title: "fresh-2",
      version: 1,
    } as any);
    expect(updated).toBeDefined();

    const connector = DatabaseClient.getInstance().getConnection();
    const rows = await connector.query(
      `SELECT "version", "title" FROM "${tableName}" WHERE "id" = ${doc.id}`,
    );
    expect(rows[0].version).toBe(2);
    expect(rows[0].title).toBe("fresh-2");
  });

  it("updateMany() bumps the version for every matched row", async () => {
    const a: any = await conn.em.save(Doc, { title: "batch" });
    const b: any = await conn.em.save(Doc, { title: "batch" });

    await conn.em.updateMany(
      Doc,
      { title: "batched" } as any,
      { where: { title: "batch" } as any },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    const rows = await connector.query(
      `SELECT "id", "version" FROM "${tableName}" WHERE "id" IN (${a.id}, ${b.id})`,
    );
    for (const r of rows) {
      expect(r.version).toBe(2);
    }
  });
});
