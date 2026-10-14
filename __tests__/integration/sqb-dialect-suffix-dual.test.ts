/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Dialect-specific SELECT clauses on a real PostgreSQL / MySQL (MariaDB):
 * row locks with NOWAIT / SKIP LOCKED, index hints, the raw builder's CTEs,
 * and DISTINCT. Each is spelled differently per dialect — the unit suites
 * only compare the generated strings — so only the server can say whether
 * the SQL parses and does what the method promises.
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import { Entity, Column, PrimaryGeneratedColumn, Index } from "../../src";
import { LockMode } from "../../src/dialects/FindOption";
import { sql } from "../../src/utils/sqlTag";

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** The driver's own error, wherever the ORM put it. */
function driverError(e: any): any {
  let cur = e;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.code !== undefined && (typeof cur.errno === "number" || /^[0-9A-Z]{5}$/.test(cur.code))) {
      return cur;
    }
    cur = cur.cause ?? cur.originalError ?? cur.original;
  }
  return e;
}

/** True when the server refused to wait for a row lock (NOWAIT). */
function isLockNotAvailable(type: string, e: any): boolean {
  const d = driverError(e);
  if (type === "postgres") return d?.code === "55P03";
  // MySQL 8: ER_LOCK_NOWAIT; MariaDB reports NOWAIT as a zero-second wait.
  return d?.errno === 3572 || d?.errno === 1205;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

describe.each(getTestDrivers())(
  "[Integration] $label: dialect-specific SELECT clauses",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Task: new () => any;
    const suffix = String(Date.now()).slice(-7);
    const table = `sds_task_${suffix}`;
    const statusIndex = `sds_status_${suffix}`;
    let ids: Record<string, number>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options, pool: { max: 6 } } as any,
        () => {
          @Entity({ name: table })
          @Index(["status"], statusIndex)
          class SdsTask {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) title!: string;
            @Column({ type: "varchar", length: 20 }) status!: string;
            @Column({ type: "int", nullable: true }) parentId!: number | null;
          }
          Task = SdsTask;
          return { entities: [SdsTask] };
        },
      );
      em = conn.em;
    }, 60000);

    beforeEach(async () => {
      await rawQuery(`DELETE FROM ${qi(type, table)}`);
      const root = await em.save(Task, { title: "root", status: "open", parentId: null });
      const a = await em.save(Task, { title: "a", status: "open", parentId: root.id });
      const b = await em.save(Task, { title: "b", status: "done", parentId: root.id });
      const c = await em.save(Task, { title: "c", status: "open", parentId: a.id });
      ids = { root: root.id, a: a.id, b: b.id, c: c.id };
    });

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const qb = () => em.createQueryBuilder(Task, "t");
    const titles = (rows: any[]) => rows.map((r) => r.title).sort();

    /**
     * Opens a transaction that holds `root` with FOR UPDATE until `release()`,
     * so another transaction meets a row it cannot lock.
     */
    async function holdRoot(): Promise<{ release: () => Promise<void> }> {
      const locked = gate();
      const done = gate();
      const holder = em.transaction(async () => {
        await qb().where("id", ids.root).forUpdate().getMany();
        locked.open();
        await done.promise;
      });
      await locked.promise;
      return {
        release: async () => {
          done.open();
          await holder;
        },
      };
    }

    // ── row locks ─────────────────────────────────────────────────

    describe("row locks", () => {
      it("forUpdateNowait() fails at once on a row another transaction holds", async () => {
        const hold = await holdRoot();
        try {
          const e = await errorOf(
            em.transaction(() => qb().where("id", ids.root).forUpdateNowait().getMany()),
          );
          expect(isLockNotAvailable(type, e)).toBe(true);
        } finally {
          await hold.release();
        }
      });

      it("forUpdateSkipLocked() returns the rows no other transaction holds", async () => {
        const hold = await holdRoot();
        try {
          const rows = await em.transaction(() => qb().forUpdateSkipLocked().getMany());
          expect(titles(rows)).toEqual(["a", "b", "c"]);
        } finally {
          await hold.release();
        }
      });

      it("forShare() takes a lock two transactions hold together", async () => {
        const locked = gate();
        const done = gate();
        const first = em.transaction(async () => {
          await qb().where("id", ids.root).forShare().getMany();
          locked.open();
          await done.promise;
        });
        await locked.promise;
        try {
          const rows = await em.transaction(() =>
            qb().where("id", ids.root).forShareNowait().getMany(),
          );
          expect(titles(rows)).toEqual(["root"]);
        } finally {
          done.open();
          await first;
        }
      });

      it("forShareNowait() fails at once on a row another transaction holds for update", async () => {
        const hold = await holdRoot();
        try {
          const e = await errorOf(
            em.transaction(() => qb().where("id", ids.root).forShareNowait().getMany()),
          );
          expect(isLockNotAvailable(type, e)).toBe(true);
        } finally {
          await hold.release();
        }
      });

      it("forShareSkipLocked() returns the rows no other transaction holds for update", async () => {
        const hold = await holdRoot();
        try {
          const rows = await em.transaction(() => qb().forShareSkipLocked().getMany());
          expect(titles(rows)).toEqual(["a", "b", "c"]);
        } finally {
          await hold.release();
        }
      });

      it.each([
        [LockMode.PESSIMISTIC_WRITE_NOWAIT],
        [LockMode.PESSIMISTIC_READ_NOWAIT],
      ])("find() with lock %s fails at once on a row another transaction holds", async (lock) => {
        const hold = await holdRoot();
        try {
          const e = await errorOf(
            em.transaction(() => em.find(Task, { where: { id: ids.root }, lock })),
          );
          expect(isLockNotAvailable(type, e)).toBe(true);
        } finally {
          await hold.release();
        }
      });

      it.each([
        [LockMode.PESSIMISTIC_WRITE_SKIP_LOCKED],
        [LockMode.PESSIMISTIC_READ_SKIP_LOCKED],
      ])("find() with lock %s returns the rows no other transaction holds", async (lock) => {
        const hold = await holdRoot();
        try {
          const rows = await em.transaction(() => em.find(Task, { lock }));
          expect(titles(rows)).toEqual(["a", "b", "c"]);
        } finally {
          await hold.release();
        }
      });
    });

    // ── index hints ───────────────────────────────────────────────

    describe("index hints", () => {
      it.each(["useIndex", "forceIndex", "ignoreIndex"] as const)(
        "%s() on a real index runs and filters as without it",
        async (method) => {
          const rows = await (qb().where("status", "open") as any)[method](statusIndex).getMany();
          expect(titles(rows)).toEqual(["a", "c", "root"]);
        },
      );

      it("reaches MySQL, where an unknown index is an error, and is left out on PostgreSQL", async () => {
        const e = await errorOf(qb().useIndex(`no_such_index_${suffix}`).getMany());
        if (type === "postgres") {
          expect(e).toBeNull();
        } else {
          // ER_KEY_DOES_NOT_EXIST
          expect(driverError(e)?.errno).toBe(1176);
        }
      });

      it("hint() is sent as a leading comment both servers accept", async () => {
        const rows = await qb().hint("SeqScan(t)").where("status", "done").getMany();
        expect(titles(rows)).toEqual(["b"]);
      });
    });

    // ── CTEs and DISTINCT ─────────────────────────────────────────

    describe("CTEs and DISTINCT", () => {
      it("withRecursive() builds a recursive CTE both servers run", async () => {
        const T = em.ref(Task);
        const C = em.ref(Task, "c");
        const tree = em.aliasRef("tree");
        const built = em
          .createQueryBuilder()
          .withRecursive(
            "tree",
            sql`
              SELECT ${T.id}, ${T.title}, 0 AS depth FROM ${T} WHERE ${T.id} = ${ids.root}
              UNION ALL
              SELECT ${C.id}, ${C.title}, ${tree.depth} + 1
              FROM ${C} INNER JOIN tree ${tree} ON ${C.parentId} = ${tree.id}
            `,
          )
          .select("*")
          .from("tree")
          .orderBy([{ column: "depth", direction: "ASC" }, { column: "title", direction: "ASC" }])
          .build();

        const rows = (await em.query(built)) as any[];
        expect(rows.map((r) => [r.title, Number(r.depth)])).toEqual([
          ["root", 0],
          ["a", 1],
          ["b", 1],
          ["c", 2],
        ]);
      });

      it("with() names a CTE the main query reads", async () => {
        const T = em.ref(Task);
        const built = em
          .createQueryBuilder()
          .with("open_tasks", sql`SELECT ${T.title} FROM ${T} WHERE ${T.status} = ${"open"}`)
          .select("*")
          .from("open_tasks")
          .build();

        const rows = (await em.query(built)) as any[];
        expect(rows.map((r) => r.title).sort()).toEqual(["a", "c", "root"]);
      });

      it("setDistinct() returns each value once", async () => {
        const rows = await qb().select(["status"]).setDistinct().getPartialMany();
        expect(rows.map((r: any) => r.status).sort()).toEqual(["done", "open"]);
      });
    });
  },
);
