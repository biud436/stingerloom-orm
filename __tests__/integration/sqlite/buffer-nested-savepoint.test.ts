/**
 * SQLite In-Memory: nested WriteBuffer SAVEPOINT semantics (issue #402 item 1).
 *
 * A nested buffer's flush() wraps its work in a SAVEPOINT — but a savepoint
 * only means anything inside an ENCLOSING transaction. WriteBuffer.flush()
 * joins an ambient `em.transaction()` via REQUIRED propagation, so:
 *
 *  - INSIDE em.transaction(): a failed nested flush rolls back to its
 *    savepoint (parent work survives), and rolling back the outer
 *    transaction discards nested-flushed work too. Real partial rollback.
 *  - OUTSIDE any transaction: each flush opens and commits its own
 *    transaction — the savepoint protects nothing beyond that flush, and a
 *    "parent rollback" can never reclaim the committed work. The buffer now
 *    logs an explicit warning for this misuse (it used to be silent, which
 *    is what issue #402 flagged as the ineffective-savepoint defect).
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
} from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: nested WriteBuffer SAVEPOINT semantics", () => {
  let conn: TestConnectionResult;
  let Prod: any;
  const tableName = `nsp_prod_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: tableName })
        class ProdEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
        }

        Prod = ProdEntity;
        return { entities: [ProdEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${tableName}"`);
  });

  async function names(): Promise<string[]> {
    const rows = (await conn.em.query(
      `SELECT "name" FROM "${tableName}" ORDER BY "name"`,
    )) as any[];
    return rows.map((r) => r.name);
  }

  it("inside em.transaction(): a failed nested flush rolls back to its savepoint only", async () => {
    await conn.em.transaction(async () => {
      const buf: WriteBuffer = (conn.em as any).buffer();
      buf.save(Prod, { name: "A" });
      await buf.flush();

      const nested = buf.beginNested();
      const b = new Prod();
      b.name = "B";
      nested.persist(b);
      // Fail AFTER the INSERT executed, so only ROLLBACK TO SAVEPOINT can
      // undo it — proving the savepoint really scopes the nested work.
      nested.onFlushEvent("postInsert", () => {
        throw new Error("boom");
      });
      await expect(nested.flush()).rejects.toThrow("boom");

      // The enclosing transaction is still usable after the savepoint
      // rollback — the parent continues its work.
      buf.save(Prod, { name: "C" });
      await buf.flush();
    });

    // Committed: parent work (A, C). Rolled back: nested work (B).
    expect(await names()).toEqual(["A", "C"]);
  });

  it("inside em.transaction(): rolling back the outer transaction discards nested-flushed work", async () => {
    await expect(
      conn.em.transaction(async () => {
        const buf: WriteBuffer = (conn.em as any).buffer();
        const nested = buf.beginNested();
        nested.save(Prod, { name: "D" });
        await nested.flush();
        // Nested flush "succeeded", but the enclosing transaction fails —
        // its rollback must reclaim the nested work too.
        throw new Error("outer-fail");
      }),
    ).rejects.toThrow("outer-fail");

    expect(await names()).toEqual([]);
  });

  it("outside a transaction: nested flush warns that the savepoint protects nothing", async () => {
    const logger = (WriteBuffer as any).logger;
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const buf: WriteBuffer = (conn.em as any).buffer();

      // A top-level flush never warns.
      buf.save(Prod, { name: "E" });
      await buf.flush();
      expect(warnSpy).not.toHaveBeenCalled();

      // A nested flush outside em.transaction() commits independently — warn.
      const nested = buf.beginNested();
      nested.save(Prod, { name: "F" });
      await nested.flush();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("enclosing transaction"),
      );

      // Degraded (documented) behavior: the work still commits.
      expect(await names()).toEqual(["E", "F"]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
