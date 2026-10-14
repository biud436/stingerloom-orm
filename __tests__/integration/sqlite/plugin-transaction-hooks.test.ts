/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A plugin's beforeTransaction / afterTransaction hooks around the
 * transactions an EntityManager opens. `beforeTransaction` receives the
 * requested isolation level — it used to be called without one, so a plugin
 * always saw `undefined`. A `@Transactional` method's transaction is opened
 * without an EntityManager, so no plugin is notified of it.
 */
import "reflect-metadata";
import { createTestConnection, type TestConnectionResult } from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn, Transactional } from "../../../src";
import type { StingerloomPlugin } from "../../../src";

describe("[Integration] SQLite: plugin transaction hooks", () => {
  let conn: TestConnectionResult;
  let Row: new () => any;
  const events: string[] = [];

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false } as any,
      () => {
        @Entity({ name: "plugin_tx_hooks" })
        class PluginTxRow {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 40 }) name!: string;
        }
        Row = PluginTxRow;
        return { entities: [PluginTxRow] };
      },
    );
    const recorder: StingerloomPlugin = {
      name: "tx-recorder",
      beforeTransaction: (isolationLevel?: string) => {
        events.push(`before:${isolationLevel}`);
      },
      afterTransaction: (committed: boolean) => {
        events.push(`after:${committed}`);
      },
      install() {
        // no extra API
      },
    };
    conn.em.extend(recorder);
  });

  beforeEach(() => {
    events.length = 0;
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("passes the requested isolation level to beforeTransaction", async () => {
    await conn.em.transaction(() => conn.em.save(Row, { name: "a" }), {
      isolationLevel: "SERIALIZABLE",
    });
    expect(events).toEqual(["before:SERIALIZABLE", "after:true"]);
  });

  it("passes undefined when no level is requested, for em.transaction() and a plain write", async () => {
    await conn.em.transaction(() => conn.em.save(Row, { name: "b" }));
    await conn.em.save(Row, { name: "c" });
    expect(events).toEqual(["before:undefined", "after:true", "before:undefined", "after:true"]);
  });

  it("reports a rolled-back transaction to afterTransaction", async () => {
    await expect(
      conn.em.transaction(async () => {
        await conn.em.save(Row, { name: "d" });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(events).toEqual(["before:undefined", "after:false"]);
  });

  it("does not notify plugins of a transaction a @Transactional method opens", async () => {
    const em = conn.em;
    class Service {
      @Transactional("SERIALIZABLE")
      async write(): Promise<void> {
        await em.save(Row, { name: "e" });
      }
    }
    await new Service().write();
    expect(events).toEqual([]);
    expect(await em.count(Row, { name: "e" } as any)).toBe(1);
  });
});
