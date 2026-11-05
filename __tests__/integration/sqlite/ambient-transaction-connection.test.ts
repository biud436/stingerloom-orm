/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * An EntityManager joins only an ambient transaction on its own connection.
 *
 * The ambient session (`@Transactional`, `em.transaction()`) was joined by
 * every manager, whatever connection it was bound to: inside a transaction on
 * "default", a manager on "reporting" read and wrote the default database,
 * and its writes rolled back with a transaction they never belonged to. A
 * `@Transactional({ connectionName })` inside another connection's
 * transaction joined it instead of opening its own.
 *
 * Both connections here are separate in-memory SQLite databases holding the
 * same table, so a statement on the wrong one succeeds silently.
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  Transactional,
  TransactionPropagation,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../../src/core/plugin/raw-pipeline/rawPipelinePlugin";

@Entity({ name: "atc_note" })
class AtcNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() body!: string;
}

async function connect(name: string): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    { type: "sqlite", database: ":memory:", entities: [AtcNote], synchronize: true, logging: false },
    name,
  );
  return em;
}

async function bodies(em: EntityManager): Promise<string[]> {
  const rows: any = await em.getDriver()!.executeRaw(`SELECT body FROM atc_note ORDER BY id`);
  const list: any[] = Array.isArray(rows) ? rows : (rows.results ?? rows.rows ?? []);
  return list.map((row) => row.body);
}

async function errorOf(fn: () => unknown | Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("[Integration] SQLite: ambient transactions stay on their connection", () => {
  let main: EntityManager;
  let reporting: EntityManager;

  beforeEach(async () => {
    main = await connect("default");
    reporting = await connect("reporting");
  });

  afterEach(async () => {
    await reporting.propagateShutdown({ closeConnections: true });
    await main.propagateShutdown({ closeConnections: true });
  });

  it("writes another connection's rows to its own database inside em.transaction()", async () => {
    await main.transaction(async () => {
      await main.save(AtcNote, { body: "main" });
      await reporting.save(AtcNote, { body: "report" });
    });

    expect(await bodies(main)).toEqual(["main"]);
    expect(await bodies(reporting)).toEqual(["report"]);
  });

  it("reads another connection's rows inside em.transaction()", async () => {
    await reporting.save(AtcNote, { body: "report" });

    const seen = await main.transaction(async () => {
      await main.save(AtcNote, { body: "main" });
      return (await reporting.find(AtcNote)).map((note) => note.body);
    });

    expect(seen).toEqual(["report"]);
  });

  it("streams another connection's rows through its pipe() inside em.transaction()", async () => {
    await reporting.save(AtcNote, { body: "report" });
    const pipeline = reporting.extend(rawPipelinePlugin()) as any;

    const streamed = await main.transaction(async () => {
      await main.save(AtcNote, { body: "main" });
      const rows: any[] = [];
      for await (const batch of pipeline.pipe(AtcNote, { orderBy: { id: "ASC" } }).raw()) {
        rows.push(...batch);
      }
      return rows.map((row) => row.body);
    });

    expect(streamed).toEqual(["report"]);
  });

  it("leaves another connection's write out of the rollback", async () => {
    const error = await errorOf(() =>
      main.transaction(async () => {
        await main.save(AtcNote, { body: "main" });
        await reporting.save(AtcNote, { body: "report" });
        throw new Error("boom");
      }),
    );

    expect(error?.message).toBe("boom");
    expect(await bodies(main)).toEqual([]);
    expect(await bodies(reporting)).toEqual(["report"]);
  });

  it("keeps the outer connection's transaction joinable inside another connection's", async () => {
    const error = await errorOf(() =>
      main.transaction(async () => {
        await reporting.transaction(async () => {
          // Joins the outer transaction on "default", not the inner one.
          await main.save(AtcNote, { body: "main" });
          await reporting.save(AtcNote, { body: "report" });
        });
        throw new Error("boom");
      }),
    );

    expect(error?.message).toBe("boom");
    expect(await bodies(main)).toEqual([]);
    expect(await bodies(reporting)).toEqual(["report"]);
  });

  it("opens a NESTED transaction on its own connection when only another one is ambient", async () => {
    await main.transaction(async () => {
      await reporting.transaction(
        async () => {
          await reporting.save(AtcNote, { body: "report" });
        },
        { propagation: TransactionPropagation.NESTED },
      );
    });

    expect(await bodies(main)).toEqual([]);
    expect(await bodies(reporting)).toEqual(["report"]);
  });

  it("runs the manager's work on the connection em.transaction({ connectionName }) names", async () => {
    const error = await errorOf(() =>
      main.transaction(
        async (txEm) => {
          await txEm.save(AtcNote, { body: "redirected" });
          expect(await bodies(main)).toEqual([]);
          expect((await txEm.find(AtcNote)).map((note) => note.body)).toEqual(["redirected"]);
          throw new Error("boom");
        },
        { connectionName: "reporting" },
      ),
    );

    expect(error?.message).toBe("boom");
    expect(await bodies(main)).toEqual([]);
    expect(await bodies(reporting)).toEqual([]);

    await main.transaction(async (txEm) => txEm.save(AtcNote, { body: "redirected" }), {
      connectionName: "reporting",
    });
    expect(await bodies(main)).toEqual([]);
    expect(await bodies(reporting)).toEqual(["redirected"]);
  });

  describe("@Transactional", () => {
    class NoteService {
      constructor(
        private readonly mainEm: EntityManager,
        private readonly reportingEm: EntityManager,
      ) {}

      @Transactional()
      async writeBoth(fail: boolean): Promise<void> {
        await this.mainEm.save(AtcNote, { body: "main" });
        await this.reportingEm.save(AtcNote, { body: "report" });
        if (fail) throw new Error("boom");
      }

      @Transactional({ connectionName: "reporting" })
      async writeReport(fail: boolean): Promise<void> {
        await this.reportingEm.save(AtcNote, { body: "report" });
        if (fail) throw new Error("boom");
      }
    }

    it("writes another connection's rows to its own database", async () => {
      const service = new NoteService(main, reporting);
      expect((await errorOf(() => service.writeBoth(true)))?.message).toBe("boom");

      expect(await bodies(main)).toEqual([]);
      expect(await bodies(reporting)).toEqual(["report"]);
    });

    it("opens its own transaction on its connection inside another connection's", async () => {
      const service = new NoteService(main, reporting);
      const error = await errorOf(() =>
        main.transaction(async () => {
          await main.save(AtcNote, { body: "main" });
          // Its own transaction on "reporting" rolls back on its own.
          await errorOf(() => service.writeReport(true));
          await service.writeReport(false);
          throw new Error("boom");
        }),
      );

      expect(error?.message).toBe("boom");
      expect(await bodies(main)).toEqual([]);
      expect(await bodies(reporting)).toEqual(["report"]);
    });
  });
});
