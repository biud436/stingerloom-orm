/**
 * SQLite In-Memory: entity lifecycle hooks on WriteBuffer flushes.
 *
 * The buffer flushes an instance by handing save() a copy of its column
 * values. The copy was a plain object, and save() runs hooks as methods of
 * the object it is given, so `@BeforeInsert` / `@BeforeUpdate` and the
 * defineEntity `hooks` never ran for persisted or tracked instances.
 *
 * On SQLite a `batchInsert` group is written one row at a time, so these
 * cover the per-row paths; the multi-row INSERT is covered on PostgreSQL /
 * MySQL by __tests__/integration/buffer-batch-insert-parity.test.ts.
 */

import "reflect-metadata";
import { createTestConnection, type TestConnectionResult } from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn, BeforeInsert, BeforeUpdate } from "../../../src";
import { defineEntity, t } from "../../../src/schema";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";

describe("[Integration] SQLite: entity hooks on WriteBuffer flushes", () => {
  let conn: TestConnectionResult;
  let Article: any;
  let Note: any;
  const suffix = String(Date.now()).slice(-6);

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false, plugins: [bufferPlugin()] },
      () => {
        @Entity({ name: `bfh_article_${suffix}` })
        class HookArticle {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 60 }) title!: string;
          @Column({ type: "varchar", length: 60, nullable: true }) slug!: string | null;
          @Column({ type: "int", default: 0 }) edits!: number;

          @BeforeInsert() makeSlug() {
            this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
          }

          @BeforeUpdate() countEdit() {
            this.edits = (this.edits ?? 0) + 1;
          }
        }

        const HookNote = defineEntity(
          `bfh_note_${suffix}`,
          {
            id: t.int().primary().generated(),
            body: t.varchar(60),
            preview: t.varchar(20).nullable(),
          },
          {
            hooks: {
              beforeInsert(note) {
                note.preview = note.body.slice(0, 5);
              },
            },
          },
        );

        Article = HookArticle;
        Note = HookNote;
        return { entities: [HookArticle, HookNote] };
      },
    );
  });

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  const buffer = (options = {}): WriteBuffer => (conn.em as any).buffer(options);

  it.each([false, true])("runs @BeforeInsert on persisted instances (batchInsert: %s)", async (batchInsert) => {
    const buf = buffer({ batchInsert });
    const first = Object.assign(new Article(), { title: `Hello World ${batchInsert}` });
    const second = Object.assign(new Article(), { title: `Second Post ${batchInsert}` });
    buf.persist(first).persist(second);

    await buf.flush();

    const stored = await conn.em.find(Article, { where: { id: [first.id, second.id] } as any, orderBy: { id: "ASC" } });
    expect(stored.map((a: any) => a.slug)).toEqual([`hello-world-${batchInsert}`, `second-post-${batchInsert}`]);
    expect(first.slug).toBe(`hello-world-${batchInsert}`);
  });

  it("runs @BeforeUpdate on a tracked instance", async () => {
    const saved: any = await conn.em.save(Article, Object.assign(new Article(), { title: "Tracked" }));
    const buf = buffer();
    const tracked: any = await buf.findOne(Article, { where: { id: saved.id } });
    tracked.title = "Tracked again";

    await buf.flush();

    const stored: any = await conn.em.findOne(Article, { where: { id: saved.id } });
    expect([stored.title, stored.edits]).toEqual(["Tracked again", 1]);
  });

  it("runs a defineEntity beforeInsert hook on persisted instances", async () => {
    const buf = buffer();
    const note = new Note({ body: "buffered body" });
    buf.persist(note);

    await buf.flush();

    const stored: any = await conn.em.findOne(Note, { where: { id: note.id } });
    expect(stored.preview).toBe("buffe");
  });
});
