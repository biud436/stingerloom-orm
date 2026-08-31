/**
 * Every write path must persist the same instant for the same Date, with
 * millisecond precision, in one textual format.
 *
 * Before this suite, three paths (insertMany, insertManyAndReturn,
 * batchUpsert) and the auto timestamp columns went through a local wall-clock
 * formatter that dropped the zone and the milliseconds, while save/upsert/
 * update bound the Date and got ISO-8601 UTC from the connector — so one
 * column could hold two formats, and a row written by insertMany came back
 * with its milliseconds zeroed. SQLite `softDelete` was worse: it stamped
 * `datetime('now')` (UTC, zone-less) and the reader decoded zone-less text as
 * local time, so `deletedAt` came back shifted by the process offset.
 *
 * `pnpm test:temporal-tz` replays this file under several process timezones,
 * because a UTC-only test environment hides every one of those defects.
 */
import "reflect-metadata";
import {
  Column,
  CreateTimestamp,
  DeletedAt,
  Entity,
  PrimaryColumn,
  UpdateTimestamp,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "twc_events" })
class TwcEvent {
  @PrimaryColumn({ type: "int" })
  id!: number;

  @Column({ type: "datetime" })
  occurredAt!: Date;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @DeletedAt()
  deletedAt?: Date;
}

/** A source instant with a non-zero millisecond component. */
const SOURCE = new Date("2026-03-01T12:34:56.789Z");

type StoredRow = { id: number; occurredAt: string; createdAt: string };

/**
 * The active process timezone. Assigning `process.env.TZ` inside a Jest test
 * does not reach V8's timezone cache (Jest hands the test a plain `process.env`
 * copy without Node's TZ setter), so the zone has to come from the environment
 * — `pnpm test:temporal-tz` runs this file under several of them.
 */
const TZ_LABEL = process.env.TZ ?? "(system default)";

describe(
  `[Integration] SQLite: temporal write consistency (TZ=${TZ_LABEL})`,
  () => {
    let em: EntityManager;

    beforeAll(async () => {
      em = await createTestEntityManager({ entities: [TwcEvent] });
    });

    afterAll(async () => {
      await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    });

    /** Writes one row per path, each carrying the same source instant. */
    async function writeAllPaths(): Promise<void> {
      const row = (id: number) => ({
        id,
        occurredAt: SOURCE,
        createdAt: SOURCE,
        updatedAt: SOURCE,
      });

      await em.save(TwcEvent, row(1) as never);
      await em.saveMany(TwcEvent, [row(2)] as never);
      await em.insertMany(TwcEvent, [row(3)] as never);
      await em.insertManyAndReturn(TwcEvent, [row(4)] as never);
      await em.upsert(TwcEvent, row(5) as never, ["id"]);
      await em.batchUpsert(TwcEvent, [row(6)] as never, ["id"]);
    }

    const PATHS = [
      "save",
      "saveMany",
      "insertMany",
      "insertManyAndReturn",
      "upsert",
      "batchUpsert",
    ];

    beforeEach(async () => {
      await em.query("DELETE FROM twc_events");
      await writeAllPaths();
    });

    it("round-trips the exact instant, milliseconds included, on every path", async () => {
      const rows = await em.find(TwcEvent, { orderBy: { id: "ASC" } });

      expect(rows).toHaveLength(PATHS.length);
      for (const row of rows) {
        const label = PATHS[row.id - 1];
        expect(row.occurredAt).toBeInstanceOf(Date);
        expect(`${label}: ${row.occurredAt.toISOString()}`).toBe(
          `${label}: ${SOURCE.toISOString()}`,
        );
      }
    });

    it("stores one textual format for the column across every path", async () => {
      const stored = (await em.query(
        "SELECT id, occurredAt, createdAt FROM twc_events ORDER BY id",
      )) as unknown as StoredRow[];

      const shapes = new Set(stored.map((r) => String(r.occurredAt)));
      expect([...shapes]).toHaveLength(1);

      // The stored form is the connector's Date serialization: ISO-8601 UTC
      // with milliseconds. A zone-less local wall-clock string is what the
      // old formatter produced and is exactly what must not come back.
      for (const r of stored) {
        expect(String(r.occurredAt)).toBe(SOURCE.toISOString());
      }
    });

    it("writes auto timestamp columns in the same format as user-supplied dates", async () => {
      await em.query("DELETE FROM twc_events");
      await em.save(TwcEvent, { id: 10, occurredAt: SOURCE } as never);

      const [stored] = (await em.query(
        "SELECT id, occurredAt, createdAt FROM twc_events WHERE id = 10",
      )) as unknown as StoredRow[];

      // Both columns hold an instant written by the same operation, so they
      // must be encoded the same way — previously `occurredAt` was ISO-8601
      // UTC while `createdAt` was a zone-less local wall-clock string.
      expect(String(stored.createdAt)).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );

      const row = await em.findOne(TwcEvent, { where: { id: 10 } });
      expect(row?.createdAt).toBeInstanceOf(Date);
      expect(Math.abs(row!.createdAt.getTime() - Date.now())).toBeLessThan(
        60_000,
      );
    });

    it("stamps softDelete with the real deletion instant", async () => {
      const before = Date.now();
      await em.softDelete(TwcEvent, { id: 1 } as never);

      const row = await em.findOne(TwcEvent, {
        where: { id: 1 },
        withDeleted: true,
      });

      expect(row?.deletedAt).toBeInstanceOf(Date);
      const drift = row!.deletedAt!.getTime() - before;
      // Any timezone-interpretation mistake shows up as a whole-hour drift;
      // a correct stamp lands within seconds of the call.
      expect(drift).toBeGreaterThanOrEqual(-5_000);
      expect(drift).toBeLessThan(60_000);
    });

    it("restores a soft-deleted row and clears the stamp", async () => {
      await em.softDelete(TwcEvent, { id: 1 } as never);
      await em.restore(TwcEvent, { id: 1 } as never);

      const row = await em.findOne(TwcEvent, { where: { id: 1 } });
      expect(row).not.toBeNull();
      expect(row?.deletedAt ?? null).toBeNull();
    });
  },
);
