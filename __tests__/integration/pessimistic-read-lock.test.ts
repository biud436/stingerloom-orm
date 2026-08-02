/**
 * PESSIMISTIC_READ pass-through on real PostgreSQL / MySQL (issue #404).
 *
 * Until now only PESSIMISTIC_WRITE was integration-tested (buffer-plugin);
 * the PESSIMISTIC_READ suffix — `FOR SHARE` on PostgreSQL, `LOCK IN SHARE
 * MODE` on the MySQL family — was asserted nowhere against a server that
 * actually parses it. This suite proves:
 *
 *  1. the emitted suffix is accepted by both servers, inside and outside an
 *     explicit transaction, and
 *  2. it really is a SHARED lock: two overlapping transactions can hold
 *     PESSIMISTIC_READ on the same row simultaneously (an accidental
 *     FOR UPDATE would make the second acquisition block).
 *
 * NOWAIT / SKIP LOCKED read variants stay unit-only for now — see the
 * accepted-thin-spot note in __tests__/write-path-mock-inventory.md.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { LockMode } from "../../src/dialects/FindOption";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers } from "./helpers/driver-config";

const drivers = getTestDrivers();

describe.each(drivers)(
  "[Integration] $label: PESSIMISTIC_READ lock pass-through",
  ({ options }) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          entity = createCrudTestEntity("lock_read");
          return { entities: [entity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      if (!conn) return;
      try {
        await dropTestTable(entity.tableName);
      } catch {
        // ignore
      }
      await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await truncateTestTable(entity.tableName);
    });

    it("트랜잭션 안에서 PESSIMISTIC_READ findOne이 서버에 수용되고 행을 반환해야 한다", async () => {
      const saved: any = await em.save(entity.EntityClass, {
        name: "shared",
        age: 1,
      });

      const row = await em.transaction(async (tem) => {
        return tem.findOne(entity.EntityClass, {
          where: { id: saved.id } as any,
          lock: LockMode.PESSIMISTIC_READ,
        });
      });

      expect(row).toBeTruthy();
      expect((row as any).name).toBe("shared");
    });

    it("트랜잭션 밖(단문)에서도 PESSIMISTIC_READ 접미사가 서버에 수용되어야 한다", async () => {
      const saved: any = await em.save(entity.EntityClass, {
        name: "autocommit",
        age: 2,
      });

      const row = await em.findOne(entity.EntityClass, {
        where: { id: saved.id } as any,
        lock: LockMode.PESSIMISTIC_READ,
      });

      expect((row as any).name).toBe("autocommit");
    });

    it(
      "공유 잠금 의미론 — 두 트랜잭션이 같은 행의 PESSIMISTIC_READ를 동시에 보유할 수 있어야 한다",
      async () => {
        const saved: any = await em.save(entity.EntityClass, {
          name: "concurrent",
          age: 3,
        });

        let releaseTx1!: () => void;
        const tx1Hold = new Promise<void>((r) => {
          releaseTx1 = r;
        });
        let tx2Acquired = false;

        // tx1 acquires the shared lock and HOLDS it until tx2 reports in.
        const tx1 = em.transaction(async (tem) => {
          await tem.findOne(entity.EntityClass, {
            where: { id: saved.id } as any,
            lock: LockMode.PESSIMISTIC_READ,
          });
          await tx1Hold;
        });

        // tx2 must be able to acquire the SAME row's shared lock while tx1
        // still holds it. If the suffix were exclusive, this would block on
        // tx1, which itself waits for tx2 — the race below breaks that tie.
        const tx2 = em.transaction(async (tem) => {
          await tem.findOne(entity.EntityClass, {
            where: { id: saved.id } as any,
            lock: LockMode.PESSIMISTIC_READ,
          });
          tx2Acquired = true;
        });

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), 8000);
        });
        const raced = await Promise.race([tx2.then(() => "acquired"), timeout]);
        if (timer) clearTimeout(timer);

        // Unwind tx1 regardless of outcome so a failure doesn't leak a
        // held transaction into the next test.
        releaseTx1();
        await Promise.all([tx1, tx2].map((p) => p.catch(() => undefined)));

        expect(raced).toBe("acquired");
        expect(tx2Acquired).toBe(true);
      },
      20000,
    );
  },
);
