/**
 * SQLite In-Memory: EntitySubscriber against real sessions (issue #404).
 *
 * Backfills two thin spots that were only ever asserted against mocks in
 * __tests__/unit/entity-subscriber.test.ts:
 *
 *  - The UPDATE `databaseEntity` before-image: the unit test feeds the
 *    pre-read row through a mocked findOneInternal, so "the snapshot is the
 *    row state captured before the UPDATE" had never been checked against a
 *    real SELECT-then-UPDATE. Here the snapshot must equal what was really
 *    persisted before the save.
 *
 *  - Transaction lifecycle hooks: the unit test invokes
 *    notifyTransactionSubscribers() directly, which proves dispatch but not
 *    that TransactionRunner wires the six hooks around a REAL BEGIN/COMMIT/
 *    ROLLBACK at the right points. Here the hook order is recorded across a
 *    real committed and a real rolled-back transaction, and the rollback
 *    case also proves the data was actually discarded.
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
import type { EntitySubscriber, UpdateEvent } from "../../../src/core/EntitySubscriber";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: EntitySubscriber with real sessions", () => {
  let conn: TestConnectionResult;
  let User: any;
  const table = `sub_sess_${String(Date.now()).slice(-6)}`;

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
          @Column() email!: string;
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

  describe("UPDATE databaseEntity before-image", () => {
    it("beforeUpdate/afterUpdate의 databaseEntity가 실제 UPDATE 직전 DB 행이어야 한다", async () => {
      const saved: any = await conn.em.save(User, {
        name: "Original",
        email: "orig@test.com",
      });

      const events: Array<{ hook: string; event: UpdateEvent<any> }> = [];
      subscribe({
        listenTo: () => User,
        beforeUpdate: (e: UpdateEvent<any>) => { events.push({ hook: "before", event: e }); },
        afterUpdate: (e: UpdateEvent<any>) => { events.push({ hook: "after", event: e }); },
      });

      await conn.em.save(User, { id: saved.id, name: "Updated" });

      expect(events.map((e) => e.hook)).toEqual(["before", "after"]);

      // The before-image is the REAL pre-update row — including the email
      // column the update statement never touched.
      const before = events[0].event;
      expect(before.databaseEntity).toMatchObject({
        id: saved.id,
        name: "Original",
        email: "orig@test.com",
      });
      expect(before.entity).toMatchObject({ id: saved.id, name: "Updated" });

      // afterUpdate receives the same pre-update snapshot for diffing.
      expect(events[1].event.databaseEntity).toMatchObject({
        id: saved.id,
        name: "Original",
      });

      // And the row itself really changed underneath.
      const row: any = await conn.em.findOne(User, { where: { id: saved.id } });
      expect(row.name).toBe("Updated");
      expect(row.email).toBe("orig@test.com");
    });

    it("연속 UPDATE — 두 번째 이벤트의 databaseEntity는 첫 UPDATE의 결과여야 한다", async () => {
      const saved: any = await conn.em.save(User, {
        name: "V1",
        email: "v@test.com",
      });

      const snapshots: any[] = [];
      subscribe({
        listenTo: () => User,
        beforeUpdate: (e: UpdateEvent<any>) => { snapshots.push(e.databaseEntity); },
      });

      await conn.em.save(User, { id: saved.id, name: "V2" });
      await conn.em.save(User, { id: saved.id, name: "V3" });

      expect(snapshots.map((s) => s?.name)).toEqual(["V1", "V2"]);
    });
  });

  describe("transaction lifecycle hooks on a real session", () => {
    function trackingSubscriber(events: string[]): EntitySubscriber<any> {
      return {
        listenTo: () => User,
        beforeInsert: () => { events.push("beforeInsert"); },
        afterInsert: () => { events.push("afterInsert"); },
        beforeTransactionStart: () => { events.push("beforeTxStart"); },
        afterTransactionStart: () => { events.push("afterTxStart"); },
        beforeTransactionCommit: () => { events.push("beforeTxCommit"); },
        afterTransactionCommit: () => { events.push("afterTxCommit"); },
        beforeTransactionRollback: () => { events.push("beforeTxRollback"); },
        afterTransactionRollback: () => { events.push("afterTxRollback"); },
      };
    }

    it("커밋 — 시작/커밋 훅이 실 트랜잭션 경계 순서대로 발화하고 데이터가 커밋되어야 한다", async () => {
      const events: string[] = [];
      subscribe(trackingSubscriber(events));

      await conn.em.transaction(async (tem) => {
        await tem.save(User, { name: "TxUser", email: "tx@test.com" });
      });

      expect(events).toEqual([
        "beforeTxStart",
        "afterTxStart",
        "beforeInsert",
        "afterInsert",
        "beforeTxCommit",
        "afterTxCommit",
      ]);
      // No rollback hooks fired.
      expect(events.some((e) => e.includes("Rollback"))).toBe(false);

      const rows = await conn.em.find(User, {});
      expect(rows.length).toBe(1);
    });

    it("롤백 — 롤백 훅이 발화하고 커밋 훅은 발화하지 않으며 데이터가 실제로 버려져야 한다", async () => {
      const events: string[] = [];
      subscribe(trackingSubscriber(events));

      await expect(
        conn.em.transaction(async (tem) => {
          await tem.save(User, { name: "Ghost", email: "ghost@test.com" });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      expect(events).toEqual([
        "beforeTxStart",
        "afterTxStart",
        "beforeInsert",
        "afterInsert",
        "beforeTxRollback",
        "afterTxRollback",
      ]);
      expect(events.some((e) => e.includes("Commit"))).toBe(false);

      // The INSERT inside the transaction was really rolled back.
      const rows = await conn.em.find(User, {});
      expect(rows).toEqual([]);
    });
  });
});
