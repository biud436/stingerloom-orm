/**
 * SQLite In-Memory: WriteBuffer @Version / @CreateTimestamp / @UpdateTimestamp
 * handling under SnakeNamingStrategy (issue #402 item 4).
 *
 * Regression: `applyNamingStrategyToEntities` rewrites the VERSION /
 * CREATE_TIMESTAMP / UPDATE_TIMESTAMP tokens to the resolved DB column name
 * ("row_version", "updated_at") for the SQL builders — but the buffer's
 * `ensureTimestamps` / `ensureVersionIncrement` / `injectOrmManagedFields`
 * used that value as an INSTANCE property key. Consequences:
 *
 *  1. `instance["updated_at"] = now` wrote a STRAY property while the real
 *     `updatedAt` stayed stale.
 *  2. `snapshot["row_version"]` was undefined, so the @Version fallback
 *     increment never ran — on drivers without RETURNING the instance kept
 *     the old version and the NEXT flush hit a spurious OptimisticLockError.
 *  3. The batch-INSERT pre-injection wrote the stray DB-named property, so
 *     the property-keyed value read landed NULL in the multi-row INSERT.
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
  CreateTimestamp,
  UpdateTimestamp,
} from "../../../src";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: WriteBuffer version/timestamp tokens under SnakeNamingStrategy", () => {
  let conn: TestConnectionResult;
  let Doc: any;
  const tableName = `nst_doc_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        namingStrategy: new SnakeNamingStrategy(),
        plugins: [bufferPlugin()],
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: tableName })
        class DocEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          // Multi-word properties → snake_case DB columns (≠ propertyKey),
          // which is exactly what desynced the token-based instance access.
          @Version() rowVersion!: number;
          @CreateTimestamp() createdAt!: Date;
          @UpdateTimestamp() updatedAt!: Date;
        }

        Doc = DocEntity;
        return { entities: [DocEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  async function raw(sql: string, params: any[] = []): Promise<any[]> {
    return (await conn.em.query(sql, params)) as any[];
  }

  function ownProps(instance: any): string[] {
    return Object.getOwnPropertyNames(instance);
  }

  it("tracked UPDATE keeps @Version/@UpdateTimestamp on the PROPERTY, no stray DB-named fields", async () => {
    const seeded: any = await conn.em.save(Doc, { title: "v1" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const loaded: any = await buf.findOne(Doc, { where: { id: seeded.id } as any });
    expect(loaded).not.toBeNull();

    loaded.title = "v2";
    await buf.flush();

    // Regression: ensureTimestamps/ensureVersionIncrement wrote
    // instance["updated_at"] / read snapshot["row_version"].
    expect(ownProps(loaded)).not.toContain("updated_at");
    expect(ownProps(loaded)).not.toContain("row_version");
    expect(loaded.updatedAt).toBeInstanceOf(Date);
    expect(loaded.rowVersion).toBe(2);
  });

  it("a second flush after the first UPDATE does not hit a stale-version conflict", async () => {
    const seeded: any = await conn.em.save(Doc, { title: "a1" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const loaded: any = await buf.findOne(Doc, { where: { id: seeded.id } as any });

    loaded.title = "a2";
    await buf.flush();
    loaded.title = "a3";
    // Regression: with the instance stuck on the pre-update version, this
    // flush UPDATEs with WHERE row_version = <stale> → OptimisticLockError.
    await expect(buf.flush()).resolves.toBeDefined();

    expect(loaded.rowVersion).toBe(3);
    const rows = await raw(
      `SELECT "title", "row_version" FROM "${tableName}" WHERE "id" = ?`,
      [seeded.id],
    );
    expect(rows[0].title).toBe("a3");
    expect(rows[0].row_version).toBe(3);
  });

  it("batchInsert pre-injection writes the PROPERTY keys, not stray DB names", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer({ batchInsert: true });
    const d1 = new Doc();
    d1.title = "b1";
    const d2 = new Doc();
    d2.title = "b2";
    buf.persist(d1).persist(d2);
    await buf.flush();

    for (const d of [d1, d2]) {
      // Regression: injectOrmManagedFields set instance["created_at"] /
      // ["updated_at"] / ["row_version"] — stray fields the SQL value
      // binding (keyed by property) never saw.
      expect(ownProps(d)).not.toContain("created_at");
      expect(ownProps(d)).not.toContain("updated_at");
      expect(ownProps(d)).not.toContain("row_version");
      // save()'s write-back may hand back the driver's datetime representation
      // (a string on SQLite) — what matters is the PROPERTY is populated.
      expect(d.createdAt).toBeTruthy();
      expect(d.updatedAt).toBeTruthy();
      expect(d.rowVersion).toBe(1);
    }

    const rows = await raw(
      `SELECT "created_at", "row_version" FROM "${tableName}" WHERE "title" IN (?, ?) ORDER BY "id"`,
      ["b1", "b2"],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.created_at).not.toBeNull();
      expect(row.row_version).toBe(1);
    }
  });
});
