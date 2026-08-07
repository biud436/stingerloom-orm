/**
 * SQLite temporal column hydration → Date contract (V3-T1-1).
 *
 * better-sqlite3 has no column type information, so temporal columns
 * (datetime/timestamp/timestamptz/date) came back from find()/findOne() as
 * the stored TEXT ("2026-08-05T13:06:11.123Z" or "2026-08-05 22:06:11")
 * while the entity type — and the pg / mysql2 drivers — say Date. The
 * declared column type now drives a default read conversion so all three
 * drivers hydrate temporal properties as Date.
 *
 * Storage formats the ORM itself writes (both must round-trip):
 *  - driver-bound Date → Date.prototype.toISOString() (UTC, ms precision)
 *  - formatDateTimeForSQL() → local "YYYY-MM-DD HH:MM:SS" (timestamp injection
 *    and batch write paths, seconds precision)
 * plus bare "YYYY-MM-DD" for date columns, which must hydrate to LOCAL
 * midnight (pg / mysql2 convention) — never shift a calendar day.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { CreateTimestamp } from "../../../src/decorators/CreateTimestamp";
import { UpdateTimestamp } from "../../../src/decorators/UpdateTimestamp";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "th_authors" })
class ThAuthor {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 120 })
  name!: string;

  @CreateTimestamp()
  createdAt!: Date;
}

@Entity({ name: "th_posts" })
class ThPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "datetime", nullable: true })
  publishedAt?: Date;

  @Column({ type: "timestamp", nullable: true })
  reviewedAt?: Date;

  @Column({ type: "date", nullable: true })
  eventDate?: Date;

  @Column({ type: "int", nullable: true })
  authorId?: number;

  @ManyToOne(() => ThAuthor, (e: ThAuthor) => e.id, { joinColumn: "authorId" })
  author?: ThAuthor;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @DeletedAt()
  deletedAt?: Date;
}

@Entity({ name: "th_custom" })
class ThCustom {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: "datetime",
    nullable: true,
    transformer: {
      from: (raw: unknown) => `raw:${typeof raw}`,
    },
  })
  taggedAt?: Date | string;
}

describe("[Integration] SQLite: temporal column hydration returns Date", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [ThAuthor, ThPost, ThCustom],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  it("findOne hydrates datetime / timestamp columns as Date and round-trips the instant", async () => {
    const publishedAt = new Date("2026-08-05T13:06:11.123Z");
    const reviewedAt = new Date("2026-08-06T01:02:03.456Z");
    const saved = await em.save(ThPost, {
      title: "roundtrip",
      publishedAt,
      reviewedAt,
    });

    const found = await em.findOne(ThPost, { where: { id: saved.id } });
    expect(found).toBeDefined();
    expect(found!.publishedAt).toBeInstanceOf(Date);
    expect(found!.reviewedAt).toBeInstanceOf(Date);
    // Driver-bound Dates are stored as toISOString() → ms-exact round-trip.
    expect((found!.publishedAt as Date).getTime()).toBe(publishedAt.getTime());
    expect((found!.reviewedAt as Date).getTime()).toBe(reviewedAt.getTime());
  });

  it("find hydrates @CreateTimestamp / @UpdateTimestamp as Date near now", async () => {
    const before = Date.now();
    const saved = await em.save(ThPost, { title: "timestamps" });

    const rows = await em.find(ThPost, { where: { id: saved.id } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    // formatDateTimeForSQL stores local wall time at seconds precision — the
    // hydrated instant must land within the write window (no UTC/local skew).
    expect(Math.abs(row.createdAt.getTime() - before)).toBeLessThan(10_000);
    expect(Math.abs(row.updatedAt.getTime() - before)).toBeLessThan(10_000);
  });

  it('hydrates the local "YYYY-MM-DD HH:MM:SS" storage format as local wall time', async () => {
    await em.query(
      `INSERT INTO "th_posts" ("title", "publishedAt", "createdAt", "updatedAt")
       VALUES ('local-format', '2026-08-05 22:06:11', '2026-08-05 22:06:11', '2026-08-05 22:06:11')`,
    );
    const found = await em.findOne(ThPost, {
      where: { title: "local-format" },
    });
    expect(found!.publishedAt).toBeInstanceOf(Date);
    const d = found!.publishedAt as Date;
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 8, 5]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([22, 6, 11]);
  });

  it('hydrates a bare "YYYY-MM-DD" date column to local midnight — no day shift', async () => {
    await em.query(
      `INSERT INTO "th_posts" ("title", "eventDate", "createdAt", "updatedAt")
       VALUES ('date-only', '2026-08-05', '2026-08-05 00:00:00', '2026-08-05 00:00:00')`,
    );
    const found = await em.findOne(ThPost, { where: { title: "date-only" } });
    expect(found!.eventDate).toBeInstanceOf(Date);
    const d = found!.eventDate as Date;
    // Local calendar parts must match the stored literal in every timezone.
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 8, 5]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
  });

  it("hydrates @DeletedAt as Date after softDelete (withDeleted read)", async () => {
    const saved = await em.save(ThPost, { title: "soft-deleted" });
    await em.softDelete(ThPost, { id: saved.id });

    const found = await em.findOne(ThPost, {
      where: { id: saved.id },
      withDeleted: true,
    });
    expect(found).toBeDefined();
    expect(found!.deletedAt).toBeInstanceOf(Date);
  });

  it("hydrates temporal columns of an eager-joined relation as Date", async () => {
    const author = await em.save(ThAuthor, { name: "author-1" });
    const saved = await em.save(ThPost, {
      title: "with-author",
      authorId: author.id,
    });

    const found = await em.findOne(ThPost, {
      where: { id: saved.id },
      relations: ["author"],
    });
    expect(found!.author).toBeDefined();
    expect(found!.createdAt).toBeInstanceOf(Date);
    expect(found!.author!.createdAt).toBeInstanceOf(Date);
  });

  it("leaves null temporal columns as null", async () => {
    const saved = await em.save(ThPost, { title: "nulls" });
    const found = await em.findOne(ThPost, { where: { id: saved.id } });
    expect(found!.publishedAt ?? null).toBeNull();
    expect(found!.eventDate ?? null).toBeNull();
  });

  it("raw em.query() results stay raw — no Date coercion", async () => {
    const saved = await em.save(ThPost, {
      title: "raw-query",
      publishedAt: new Date("2026-08-05T13:06:11.123Z"),
    });
    const rows = await em.query<{ publishedAt: unknown }>(
      `SELECT "publishedAt" FROM "th_posts" WHERE "id" = ${Number(saved.id)}`,
    );
    expect(typeof rows[0].publishedAt).toBe("string");
  });

  it("a user @Column transformer wins over the default temporal conversion", async () => {
    const saved = await em.save(ThCustom, {
      taggedAt: new Date("2026-08-05T13:06:11.123Z"),
    });
    const found = await em.findOne(ThCustom, { where: { id: saved.id } });
    // transformer.from received the raw stored string and its result is final.
    expect(found!.taggedAt).toBe("raw:string");
  });
});
