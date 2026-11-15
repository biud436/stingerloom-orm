/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WriteBuffer flush of an instance whose key the caller chose.
 *
 * persist() treated a present uuid key as proof that the row was loaded and
 * tracked the instance instead of queueing it: a new row with a caller-chosen
 * uuid was never written, and flush() reported nothing. A persisted
 * assigned-key instance whose row already existed was written by save() as
 * an UPDATE, but the flush counted an insert and fired the insert events.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  OneToMany,
  ManyToOne,
  RelationColumn,
} from "../../../src";
import type { Relation } from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "bck_doc" })
class BckDoc {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ type: "varchar", length: 40 }) title!: string;
}

@Entity({ name: "bck_setting" })
class BckSetting {
  @PrimaryColumn({ type: "varchar", length: 20 }) key!: string;
  @Column({ type: "varchar", length: 40 }) value!: string;
}

@Entity({ name: "bck_shelf" })
class BckShelf {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => BckBook, { mappedBy: "shelf", cascade: ["insert", "update"] } as any)
  books!: BckBook[];
}

@Entity({ name: "bck_book" })
class BckBook {
  @PrimaryColumn({ type: "varchar", length: 20 }) isbn!: string;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => BckShelf, (s: BckShelf) => s.books)
  @RelationColumn({ name: "shelf_id", type: "int", nullable: true } as any)
  shelf?: Relation<BckShelf>;
}

const UUID_A = "0191e0c8-7b1a-7c3e-8f00-00000000000a";
const UUID_B = "0191e0c8-7b1a-7c3e-8f00-00000000000b";

describe.each([
  ["row by row", {}],
  ["batchInsert", { batchInsert: true }],
] as const)("[Integration] SQLite: WriteBuffer flush of a caller-chosen key (%s)", (_label, options) => {
  let em: EntityManager;

  beforeEach(async () => {
    em = new EntityManager();
    await em.register({
      type: "sqlite",
      database: ":memory:",
      entities: [BckDoc, BckSetting, BckShelf, BckBook],
      synchronize: true,
      logging: false,
      plugins: [bufferPlugin(options)],
    } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  function buffer(): WriteBuffer {
    return (em as any).buffer();
  }

  function recordEvents(buf: WriteBuffer): string[] {
    const seen: string[] = [];
    for (const type of ["preInsert", "postInsert", "preUpdate", "postUpdate"] as const) {
      buf.onFlushEvent(type, (event: any) => {
        seen.push(`${type}:${event.entity.name}`);
      });
    }
    return seen;
  }

  it("inserts a new row whose uuid the caller chose", async () => {
    const buf = buffer();
    buf.persist(Object.assign(new BckDoc(), { id: UUID_A, title: "draft" }));
    buf.persist(Object.assign(new BckDoc(), { id: UUID_B, title: "notes" }));

    const result = await buf.flush();

    expect(result).toMatchObject({ inserts: 2, updates: 0 });
    const rows = await em.find(BckDoc, { orderBy: { id: "ASC" } });
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      [UUID_A, "draft"],
      [UUID_B, "notes"],
    ]);
  });

  it("reports and announces an update for an existing row with an assigned key", async () => {
    await em.save(BckSetting, { key: "site.title", value: "Blog" });
    const buf = buffer();
    const events = recordEvents(buf);
    buf.persist(Object.assign(new BckSetting(), { key: "site.title", value: "Journal" }));
    buf.persist(Object.assign(new BckSetting(), { key: "site.lang", value: "en" }));

    const result = await buf.flush();

    expect(result).toMatchObject({ inserts: 1, updates: 1 });
    expect(events.sort()).toEqual(
      [
        "postInsert:BckSetting",
        "postUpdate:BckSetting",
        "preInsert:BckSetting",
        "preUpdate:BckSetting",
      ].sort(),
    );
    const rows = await em.find(BckSetting, { orderBy: { key: "ASC" } });
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ["site.lang", "en"],
      ["site.title", "Journal"],
    ]);
  });

  it("updates an existing row whose uuid the caller set", async () => {
    await em.save(BckDoc, { id: UUID_A, title: "draft" });
    const buf = buffer();
    buf.persist(Object.assign(new BckDoc(), { id: UUID_A, title: "final" }));

    const result = await buf.flush();

    expect(result).toMatchObject({ inserts: 0, updates: 1 });
    expect((await em.findOne(BckDoc, { where: { id: UUID_A } }))!.title).toBe("final");
  });

  it("counts a cascaded child with an existing assigned key as an update", async () => {
    await em.save(BckBook, { isbn: "978-1", title: "Old title" });
    const buf = buffer();
    const shelf = Object.assign(new BckShelf(), { name: "Fiction" });
    shelf.books = [
      Object.assign(new BckBook(), { isbn: "978-1", title: "New title" }),
      Object.assign(new BckBook(), { isbn: "978-2", title: "Second" }),
    ];
    buf.persist(shelf);

    const result = await buf.flush();

    expect(result).toMatchObject({ inserts: 2, updates: 1 });
    const books = await em.find(BckBook, { orderBy: { isbn: "ASC" } });
    expect(books.map((b: any) => [b.isbn, b.title])).toEqual([
      ["978-1", "New title"],
      ["978-2", "Second"],
    ]);
  });
});
