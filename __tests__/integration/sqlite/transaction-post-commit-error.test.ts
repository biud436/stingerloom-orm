/**
 * SQLite In-Memory: a throwing afterTransactionCommit subscriber must not
 * enter the rollback path.
 *
 * Before the fix, the post-commit notifications ran inside the same try as
 * the transaction body, so an exception thrown after a successful COMMIT
 * (e.g. a webhook call in afterTransactionCommit) fell into the catch —
 * firing beforeTransactionRollback/afterTransactionRollback for a
 * transaction that committed, and running session.rollback() after COMMIT
 * (on drivers where that throws, the caller saw TRANSACTION_ROLLBACK_FAILED
 * instead of the original error). The error still propagates to the caller;
 * only the rollback misfire is removed.
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
import type { EntitySubscriber } from "../../../src/core/EntitySubscriber";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: post-commit subscriber error", () => {
  let conn: TestConnectionResult;
  let User: any;
  const table = `post_commit_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
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
    if (conn) await conn.cleanup();
  });

  const registered: EntitySubscriber<any>[] = [];
  function subscribe(sub: EntitySubscriber<any>): void {
    conn.em.addSubscriber(sub);
    registered.push(sub);
  }

  afterEach(() => {
    while (registered.length) conn.em.removeSubscriber(registered.pop()!);
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${table}"`);
  });

  it("propagates the original error and fires no rollback hook when afterTransactionCommit throws", async () => {
    const events: string[] = [];
    subscribe({
      listenTo: () => User,
      beforeTransactionCommit: () => { events.push("beforeTxCommit"); },
      afterTransactionCommit: () => {
        events.push("afterTxCommit");
        throw new Error("webhook down");
      },
      beforeTransactionRollback: () => { events.push("beforeTxRollback"); },
      afterTransactionRollback: () => { events.push("afterTxRollback"); },
    });

    // Before the fix it entered the rollback path: on SQLite the ROLLBACK after COMMIT failed and
    // surfaced as TRANSACTION_ROLLBACK_FAILED, or the rollback hook fired by mistake.
    await expect(
      conn.em.transaction(async (tem) => {
        await tem.save(User, { name: "Committed" });
      }),
    ).rejects.toThrow("webhook down");

    expect(events).toEqual(["beforeTxCommit", "afterTxCommit"]);
    expect(events.some((e) => e.includes("Rollback"))).toBe(false);
  });

  it("keeps the committed data despite a post-commit exception", async () => {
    subscribe({
      listenTo: () => User,
      afterTransactionCommit: () => {
        throw new Error("webhook down");
      },
    });

    await conn.em
      .transaction(async (tem) => {
        await tem.save(User, { name: "Durable" });
      })
      .catch(() => undefined);

    const rows: any[] = await conn.em.find(User, {});
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Durable");
  });

  it("no regression: an exception in the body still fires the rollback hook and discards the data", async () => {
    const events: string[] = [];
    subscribe({
      listenTo: () => User,
      beforeTransactionRollback: () => { events.push("beforeTxRollback"); },
      afterTransactionRollback: () => { events.push("afterTxRollback"); },
      afterTransactionCommit: () => { events.push("afterTxCommit"); },
    });

    await expect(
      conn.em.transaction(async (tem) => {
        await tem.save(User, { name: "Ghost" });
        throw new Error("body failure");
      }),
    ).rejects.toThrow("body failure");

    expect(events).toEqual(["beforeTxRollback", "afterTxRollback"]);

    const rows: any[] = await conn.em.find(User, {});
    expect(rows).toEqual([]);
  });
});
