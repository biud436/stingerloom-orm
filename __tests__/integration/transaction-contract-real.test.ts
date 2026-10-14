/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The transaction contract on a real PostgreSQL / MySQL (MariaDB): the
 * isolation level a transaction actually runs at, which connection each
 * propagation mode uses and what survives a failure, the same through
 * `@Transactional`, and which reads open a transaction at all.
 *
 * The unit suites check these through mocked sessions and call counts. The
 * statements that decide them — BEGIN / START TRANSACTION, SET TRANSACTION,
 * SAVEPOINT, SET LOCAL — are sent by the connectors straight to the driver
 * connection, so only the server can tell whether they took effect. Where a
 * test asserts which statements were sent, it records them at the driver's
 * `query()` (the wire), not from the ORM's logger, which never sees them.
 *
 * Deadlock retry is covered by deadlock-retry-real.test.ts.
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
  type TestDriverType,
} from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Transactional,
  TransactionPropagation,
} from "../../src";
import { MetadataContext } from "../../src/metadata/MetadataContext";

const LEVELS = [
  "READ UNCOMMITTED",
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
] as const;
type Level = (typeof LEVELS)[number];

/** Statements that open, end, or shape a transaction. */
const TX_STATEMENT =
  /^(BEGIN|START TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET TRANSACTION|SET LOCAL)\b/i;

interface WireEntry {
  sql: string;
  conn: object;
}

/**
 * Records every statement sent through the driver's connection class while
 * the returned recorder is installed — including the ones the connectors
 * send directly (BEGIN, SET TRANSACTION, SET LOCAL), which bypass the ORM's
 * query logging.
 */
function recordWire(type: string): { log: WireEntry[]; stop: () => void } {
  const proto =
    type === "postgres"
      ? require("pg").Client.prototype
      : require("mysql2").Connection.prototype;
  const owned = Object.prototype.hasOwnProperty.call(proto, "query");
  const original = proto.query;
  const log: WireEntry[] = [];
  proto.query = function (this: object, first: any, ...rest: any[]) {
    const text = typeof first === "string" ? first : (first?.text ?? first?.sql);
    if (typeof text === "string") log.push({ sql: text.trim(), conn: this });
    return original.call(this, first, ...rest);
  };
  return {
    log,
    stop: () => {
      if (owned) proto.query = original;
      else delete proto.query;
    },
  };
}

/**
 * Runs `fn` with the wire recorded and returns the transaction statements the
 * ORM's connections sent — `exclude` drops a test's own probe connection.
 */
async function onWire<R>(
  type: string,
  fn: () => Promise<R>,
  exclude?: object,
): Promise<{ result: R; tx: string[] }> {
  const wire = recordWire(type);
  try {
    const result = await fn();
    const tx = wire.log
      .filter((e) => e.conn !== exclude)
      .map((e) => e.sql)
      .filter((s) => TX_STATEMENT.test(s));
    return { result, tx };
  } finally {
    wire.stop();
  }
}

interface SideConnection {
  /** The driver connection, to keep its statements out of a wire record. */
  raw: object;
  query(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/** A plain driver connection outside the ORM's pool, for MySQL probes. */
async function openMySqlSide(options: any): Promise<SideConnection> {
  const mysql = require("mysql2/promise");
  const conn = await mysql.createConnection({
    host: options.host,
    port: options.port,
    user: options.username,
    password: options.password,
    database: options.database,
  });
  await conn.query("SET SESSION innodb_lock_wait_timeout = 1");
  return {
    raw: conn.connection,
    query: async (sql: string) => (await conn.query(sql))[0],
    close: () => conn.end(),
  };
}

/**
 * The isolation level the current transaction runs at, as the server applies
 * it. PostgreSQL reports it. MySQL/MariaDB only report the session default
 * (`@@transaction_isolation` ignores SET TRANSACTION), so there it is
 * classified by behavior against a second connection: SERIALIZABLE turns the
 * plain read into a shared lock that blocks a writer; REPEATABLE READ keeps
 * its snapshot across a committed change; READ UNCOMMITTED sees an
 * uncommitted one; READ COMMITTED sees neither.
 */
async function observeIsolation(probe: {
  type: TestDriverType;
  em: EntityManager;
  Row: new () => any;
  table: string;
  rowId: number;
  side?: SideConnection;
}): Promise<Level> {
  const { type, em, Row, table, rowId, side } = probe;
  if (type === "postgres") {
    const rows = (await em.query("SHOW transaction_isolation")) as any[];
    return rows[0].transaction_isolation.toUpperCase() as Level;
  }
  const t = (name: string) => qi(type, name);
  const read = async (): Promise<number> =>
    (await em.findOne(Row, { where: { id: rowId } })).val;
  const bump = (by: number) =>
    `UPDATE ${t(table)} SET ${t("val")} = ${t("val")} + ${by} WHERE ${t("id")} = ${rowId}`;
  const v0 = await read();
  try {
    await side!.query(bump(1));
  } catch (e: any) {
    if (e?.errno === 1205) return "SERIALIZABLE";
    throw e;
  }
  const v1 = await read();
  if (v1 === v0) return "REPEATABLE READ";
  await side!.query("START TRANSACTION");
  try {
    await side!.query(bump(100));
    return (await read()) === v1 + 100 ? "READ UNCOMMITTED" : "READ COMMITTED";
  } finally {
    await side!.query("ROLLBACK");
  }
}

describe.each(getTestDrivers())(
  "[Integration] $label: transaction contract",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Row: new () => any;
    let side: SideConnection | undefined;
    let probeId: number;
    const table = `txc_${String(Date.now()).slice(-7)}`;
    const t = (name: string) => qi(type, name);

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options, pool: { max: 6 } } as any,
        () => {
          @Entity({ name: table })
          class TxcRow {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @Column({ type: "int" }) val!: number;
          }
          Row = TxcRow;
          return { entities: [TxcRow] };
        },
      );
      em = conn.em;
      if (type !== "postgres") side = await openMySqlSide(options);
    }, 60000);

    beforeEach(async () => {
      await rawQuery(`DELETE FROM ${t(table)}`);
      probeId = (await em.save(Row, { name: "probe", val: 0 })).id;
    });

    afterAll(async () => {
      if (side) await side.close();
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const sessionId = async (): Promise<number> => {
      const sql =
        type === "postgres"
          ? "SELECT pg_backend_pid() AS id"
          : "SELECT CONNECTION_ID() AS id";
      return Number(((await em.query(sql)) as any[])[0].id);
    };

    const names = async (): Promise<string[]> =>
      (await em.find(Row, { orderBy: { id: "ASC" } }))
        .map((r: any) => r.name)
        .filter((n: string) => n !== "probe");

    const observedIsolation = (): Promise<Level> =>
      observeIsolation({ type, em, Row, table, rowId: probeId, side });

    // ── (a) isolation level ──────────────────────────────────────────

    describe("isolation level", () => {
      it.each(LEVELS)("isolationLevel %s is the level the transaction runs at", async (level) => {
        const observed = await em.transaction(() => observedIsolation(), {
          isolationLevel: level,
        });
        expect(observed).toBe(level);
      });

      it("without isolationLevel a transaction runs at READ COMMITTED", async () => {
        const { result, tx } = await onWire(
          type,
          () => em.transaction(() => observedIsolation()),
          side?.raw,
        );
        expect(result).toBe("READ COMMITTED");
        // PostgreSQL's own default is READ COMMITTED, so no SET is sent;
        // InnoDB defaults to REPEATABLE READ, so MySQL needs one.
        if (type === "postgres") {
          expect(tx).toEqual(["BEGIN", "COMMIT"]);
        } else {
          expect(tx).toEqual([
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
            "START TRANSACTION",
            "COMMIT",
          ]);
        }
      });

      it("sets the level after BEGIN on PostgreSQL and before START TRANSACTION on MySQL", async () => {
        const { tx } = await onWire(type, () =>
          em.transaction(() => em.find(Row), { isolationLevel: "SERIALIZABLE" }),
        );
        expect(tx).toEqual(
          type === "postgres"
            ? ["BEGIN", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", "COMMIT"]
            : ["SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", "START TRANSACTION", "COMMIT"],
        );
      });
    });

    // ── (b) REQUIRES_NEW / REQUIRED ──────────────────────────────────

    describe("REQUIRES_NEW and REQUIRED", () => {
      it("REQUIRES_NEW runs on a second connection whose commit survives the outer rollback", async () => {
        let outerId = 0;
        let innerId = 0;
        await expect(
          em.transaction(async () => {
            outerId = await sessionId();
            await em.save(Row, { name: "outer", val: 0 });
            await em.transaction(
              async () => {
                innerId = await sessionId();
                await em.save(Row, { name: "inner", val: 0 });
              },
              { propagation: TransactionPropagation.REQUIRES_NEW },
            );
            throw new Error("outer failed");
          }),
        ).rejects.toThrow("outer failed");

        expect(innerId).not.toBe(outerId);
        expect(await names()).toEqual(["inner"]);
      });

      it("a failing REQUIRES_NEW callback rolls back only itself; the outer transaction commits", async () => {
        await em.transaction(async () => {
          await em.save(Row, { name: "outer", val: 0 });
          await expect(
            em.transaction(
              async () => {
                await em.save(Row, { name: "inner", val: 0 });
                throw new Error("inner failed");
              },
              { propagation: "REQUIRES_NEW" },
            ),
          ).rejects.toThrow("inner failed");
          await em.save(Row, { name: "after", val: 0 });
        });

        expect(await names()).toEqual(["outer", "after"]);
      });

      it("REQUIRES_NEW does not see the outer transaction's uncommitted rows", async () => {
        const seen = await em.transaction(async () => {
          await em.save(Row, { name: "outer", val: 0 });
          return em.transaction(() => names(), { propagation: "REQUIRES_NEW" });
        });
        expect(seen).toEqual([]);
        expect(await names()).toEqual(["outer"]);
      });

      it("REQUIRED (the default) joins the outer transaction: one connection, one outcome", async () => {
        let outerId = 0;
        let innerId = 0;
        await expect(
          em.transaction(async () => {
            outerId = await sessionId();
            await em.transaction(async () => {
              innerId = await sessionId();
              await em.save(Row, { name: "inner", val: 0 });
            });
            throw new Error("outer failed");
          }),
        ).rejects.toThrow("outer failed");

        expect(innerId).toBe(outerId);
        expect(await names()).toEqual([]);
      });
    });

    // ── (c) NESTED ───────────────────────────────────────────────────

    describe("NESTED", () => {
      it("rolls back to its savepoint; the outer transaction keeps and commits its own writes", async () => {
        let outerId = 0;
        let innerId = 0;
        const { tx } = await onWire(type, () =>
          em.transaction(async () => {
            outerId = await sessionId();
            await em.save(Row, { name: "before", val: 0 });
            await expect(
              em.transaction(
                async () => {
                  innerId = await sessionId();
                  await em.save(Row, { name: "nested", val: 0 });
                  throw new Error("nested failed");
                },
                { propagation: TransactionPropagation.NESTED },
              ),
            ).rejects.toThrow("nested failed");
            await em.save(Row, { name: "after", val: 0 });
          }),
        );

        expect(innerId).toBe(outerId);
        expect(await names()).toEqual(["before", "after"]);
        const savepoint = tx.find((s) => /^SAVEPOINT /i.test(s));
        expect(savepoint).toBeDefined();
        const name = savepoint!.slice("SAVEPOINT ".length);
        expect(tx).toContainEqual(
          type === "postgres" ? `ROLLBACK TO SAVEPOINT ${name}` : `ROLLBACK TO ${name}`,
        );
        expect(tx[tx.length - 1]).toBe("COMMIT");
      });

      it("a NESTED callback's writes are discarded when the outer transaction rolls back", async () => {
        await expect(
          em.transaction(async () => {
            await em.save(Row, { name: "outer", val: 0 });
            await em.transaction(() => em.save(Row, { name: "nested", val: 0 }), {
              propagation: "NESTED",
            });
            throw new Error("outer failed");
          }),
        ).rejects.toThrow("outer failed");

        expect(await names()).toEqual([]);
      });

      it("NESTED with no outer transaction opens a transaction of its own", async () => {
        const { tx } = await onWire(type, () =>
          em.transaction(() => em.save(Row, { name: "solo", val: 0 }), {
            propagation: "NESTED",
          }),
        );
        expect(tx.some((s) => /^SAVEPOINT /i.test(s))).toBe(false);
        expect(tx[tx.length - 1]).toBe("COMMIT");
        expect(await names()).toEqual(["solo"]);
      });
    });

    // ── (d) @Transactional ──────────────────────────────────────────

    describe("@Transactional", () => {
      class Ledger {
        @Transactional()
        async required(name: string, work?: () => Promise<unknown>): Promise<number> {
          await em.save(Row, { name, val: 0 });
          if (work) await work();
          return sessionId();
        }

        @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
        async independent(name: string, fail = false): Promise<number> {
          await em.save(Row, { name, val: 0 });
          if (fail) throw new Error("independent failed");
          return sessionId();
        }

        @Transactional({ propagation: "NESTED" })
        async nested(name: string, fail = false): Promise<number> {
          await em.save(Row, { name, val: 0 });
          if (fail) throw new Error("nested failed");
          return sessionId();
        }

        @Transactional("SERIALIZABLE")
        async serializable(): Promise<Level> {
          return observedIsolation();
        }

        @Transactional({ isolationLevel: "REPEATABLE READ", propagation: "REQUIRES_NEW" })
        async repeatableRead(): Promise<Level> {
          return observedIsolation();
        }
      }
      const ledger = new Ledger();

      it("commits the method's writes and rolls them back when it throws", async () => {
        await ledger.required("kept");
        await expect(
          ledger.required("discarded", async () => {
            throw new Error("method failed");
          }),
        ).rejects.toThrow("method failed");

        expect(await names()).toEqual(["kept"]);
      });

      it("REQUIRES_NEW runs on its own connection and keeps its commit when the caller rolls back", async () => {
        let outerId = 0;
        let innerId = 0;
        await expect(
          ledger.required("outer", async () => {
            outerId = await sessionId();
            innerId = await ledger.independent("independent");
            throw new Error("caller failed");
          }),
        ).rejects.toThrow("caller failed");

        expect(innerId).not.toBe(outerId);
        expect(await names()).toEqual(["independent"]);
      });

      it("NESTED rolls back only its own writes on the caller's connection", async () => {
        let callerId = 0;
        let nestedId = 0;
        callerId = await ledger.required("caller", async () => {
          nestedId = await ledger.nested("kept-nested");
          await expect(ledger.nested("failed-nested", true)).rejects.toThrow("nested failed");
        });

        expect(nestedId).toBe(callerId);
        expect(await names()).toEqual(["caller", "kept-nested"]);
      });

      it("the decorator's isolation level is the level the method runs at", async () => {
        expect(await ledger.serializable()).toBe("SERIALIZABLE");
        expect(await ledger.repeatableRead()).toBe("REPEATABLE READ");
      });
    });

    // ── (e) reads outside a transaction ──────────────────────────────

    describe("reads outside a transaction", () => {
      it("find() sends no BEGIN / START TRANSACTION", async () => {
        const { result, tx } = await onWire(type, () => em.find(Row));
        expect(result).toHaveLength(1);
        expect(tx).toEqual([]);
      });

      it("a find() with a timeout opens a transaction on PostgreSQL only", async () => {
        const { tx } = await onWire(type, () => em.find(Row, { timeout: 5000 }));
        // PostgreSQL's SET LOCAL statement_timeout is a no-op outside a
        // transaction; MySQL/MariaDB set a session variable and restore it.
        if (type === "postgres") {
          expect(tx[0]).toBe("BEGIN");
          expect(tx).toContain("SET LOCAL statement_timeout = '5000ms'");
          expect(tx[tx.length - 1]).toBe("COMMIT");
        } else {
          expect(tx).toEqual([]);
        }
      });

      (type === "postgres" ? it : it.skip)(
        "find() in a search_path tenant context runs in a transaction and reads the tenant's schema",
        async () => {
          const tenant = `txc_tenant_${String(Date.now()).slice(-7)}`;
          await rawQuery(`CREATE SCHEMA "${tenant}"`);
          try {
            await rawQuery(
              `CREATE TABLE "${tenant}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`,
            );
            await rawQuery(
              `INSERT INTO "${tenant}"."${table}" ("name", "val") VALUES ('tenant-row', 0)`,
            );

            const { result, tx } = await onWire(type, () =>
              MetadataContext.run(tenant, () => em.find(Row)) as Promise<any[]>,
            );

            expect(result.map((r) => r.name)).toEqual(["tenant-row"]);
            expect(tx).toEqual(["BEGIN", `SET LOCAL search_path TO "${tenant}"`, "COMMIT"]);
          } finally {
            await rawQuery(`DROP SCHEMA IF EXISTS "${tenant}" CASCADE`);
          }
        },
      );
    });
  },
);

/**
 * The session's default isolation level is whatever the server, a role, or a
 * SET SESSION made it — not necessarily the database's out-of-the-box one.
 * One pooled connection, so the SET SESSION reaches every transaction below.
 */
describe.each(getTestDrivers())(
  "[Integration] $label: isolation level against a non-default session default",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Row: new () => any;
    let side: SideConnection | undefined;
    let rowId: number;
    const table = `txd_${String(Date.now()).slice(-7)}`;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options, pool: { max: 1 } } as any,
        () => {
          @Entity({ name: table })
          class TxdRow {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) val!: number;
          }
          Row = TxdRow;
          return { entities: [TxdRow] };
        },
      );
      em = conn.em;
      if (type !== "postgres") side = await openMySqlSide(options);
      rowId = (await em.save(Row, { val: 0 })).id;
      await rawQuery(
        type === "postgres"
          ? "SET SESSION default_transaction_isolation = 'serializable'"
          : "SET SESSION transaction_isolation = 'SERIALIZABLE'",
      );
    }, 60000);

    afterAll(async () => {
      if (side) await side.close();
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const observedIsolation = (): Promise<Level> =>
      observeIsolation({ type, em, Row, table, rowId, side });

    it("a requested level equal to the database's usual default is still applied", async () => {
      // READ COMMITTED is PostgreSQL's out-of-the-box default, REPEATABLE
      // READ InnoDB's — the levels whose SET used to be skipped.
      const level = type === "postgres" ? "READ COMMITTED" : "REPEATABLE READ";
      expect(await em.transaction(() => observedIsolation(), { isolationLevel: level })).toBe(
        level,
      );
    });

    it("@Transactional applies its level the same way", async () => {
      class Probe {
        @Transactional("READ COMMITTED")
        async readCommitted(): Promise<Level> {
          return observedIsolation();
        }
      }
      expect(await new Probe().readCommitted()).toBe("READ COMMITTED");
    });

    it("without a level, PostgreSQL follows the session default and MySQL runs at READ COMMITTED", async () => {
      expect(await em.transaction(() => observedIsolation())).toBe(
        type === "postgres" ? "SERIALIZABLE" : "READ COMMITTED",
      );
    });
  },
);
