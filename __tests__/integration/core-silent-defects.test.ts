/**
 * Three silent core defects: MySQL / PostgreSQL mirror
 *
 * Real-driver mirror of the SQLite in-memory reproduction tests:
 * - find take/limit 0 -> LIMIT 0 (before the fix a falsy fallback dropped LIMIT and every row came back)
 * - save() with a 0-row UPDATE -> EntityNotFoundError (before the fix: returned null and fired a phantom afterUpdate).
 *   An UPDATE that leaves the values unchanged must still succeed. MySQL can report
 *   affectedRows 0 for a value-identical UPDATE, so an existence probe covers that case (the point of this mirror).
 * - An afterTransactionCommit exception -> no rollback hooks fire and the commit stands (before the fix: it entered the rollback path)
 */

import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../src";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import { EntityNotFoundError } from "../../src/errors/EntityNotFoundError";
import type { EntitySubscriber } from "../../src/core/EntitySubscriber";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe.each(getTestDrivers())(
  "[Integration] $label: three silent core defects",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let User: any;
    const table = `silent_defects_${type}_${String(Date.now()).slice(-6)}`;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          MetadataLayerRegistry.reset();
          getScannerInstance(ColumnScanner).clear();

          @Entity({ name: table })
          class UserEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
          }

          User = UserEntity;
          return { entities: [UserEntity] };
        },
      );
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    const registered: EntitySubscriber<any>[] = [];
    function subscribe(sub: EntitySubscriber<any>): void {
      conn.em.addSubscriber(sub);
      registered.push(sub);
    }

    afterEach(() => {
      while (registered.length) conn.em.removeSubscriber(registered.pop()!);
    });

    beforeEach(async () => {
      await truncateTestTable(table);
    });

    describe("find take/limit 0", () => {
      it("take: 0 and limit: 0 produce LIMIT 0", async () => {
        await conn.em.save(User, { name: "a" });
        await conn.em.save(User, { name: "b" });

        expect(await conn.em.find(User, { take: 0 })).toEqual([]);
        expect(await conn.em.find(User, { limit: 0 })).toEqual([]);
        expect((await conn.em.find(User, { take: 1 })).length).toBe(1);
      });
    });

    describe("save() with a 0-row UPDATE", () => {
      it("save() with a PK that does not exist -> EntityNotFoundError, afterUpdate does not fire", async () => {
        const fired: string[] = [];
        subscribe({
          listenTo: () => User,
          afterUpdate: () => { fired.push("afterUpdate"); },
        });

        await expect(
          conn.em.save(User, { id: 99999, name: "ghost" }),
        ).rejects.toThrow(EntityNotFoundError);
        expect(fired).toEqual([]);
      });

      it("a save() that changes no values succeeds (MySQL affectedRows 0, existence probe)", async () => {
        const saved: any = await conn.em.save(User, { name: "same" });

        const result: any = await conn.em.save(User, {
          id: saved.id,
          name: "same",
        });

        expect(result).toMatchObject({ id: saved.id, name: "same" });
      });
    });

    describe("post-commit subscriber exception", () => {
      it("afterTransactionCommit exception -> the original propagates, rollback hooks do not fire, the commit stands", async () => {
        const events: string[] = [];
        subscribe({
          listenTo: () => User,
          afterTransactionCommit: () => {
            events.push("afterTxCommit");
            throw new Error("webhook down");
          },
          beforeTransactionRollback: () => { events.push("beforeTxRollback"); },
          afterTransactionRollback: () => { events.push("afterTxRollback"); },
        });

        await expect(
          conn.em.transaction(async (tem) => {
            await tem.save(User, { name: "Durable" });
          }),
        ).rejects.toThrow("webhook down");

        expect(events).toEqual(["afterTxCommit"]);

        const rows: any[] = await conn.em.find(User, {});
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Durable");
      });
    });
  },
);
