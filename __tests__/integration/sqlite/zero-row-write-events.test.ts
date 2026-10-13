/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Criteria writes that match no row fire no after-event.
 *
 * delete / deleteMany / update / updateMany / increment / decrement /
 * softDelete / restore used to fire their after-event on every call, so a
 * subscriber writing an audit row on `afterDelete` logged deletions that never
 * happened. save() already refused to report an UPDATE that matched nothing.
 * The after-events now fire only when the statement reported a row, and carry
 * that count as `affected`; the before-events still fire, since the count is
 * not known until the statement runs.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import type { EntityEventType } from "../../../src/core/EntityEventEmitter";
import type { DeleteEvent, EntitySubscriber } from "../../../src/core/EntitySubscriber";

@Entity({ name: "zrwe_docs" })
class ZrweDoc {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @Column({ type: "int" })
  views!: number;

  @DeletedAt()
  deletedAt!: Date | null;
}

const EVENTS: EntityEventType[] = [
  "beforeDelete",
  "afterDelete",
  "beforeUpdate",
  "afterUpdate",
  "beforeSoftDelete",
  "afterSoftDelete",
  "beforeRestore",
  "afterRestore",
];

describe("[Integration] SQLite: after-events of criteria writes that match no row", () => {
  let em: EntityManager;
  let doc: ZrweDoc;
  let emitted: { event: EntityEventType; affected: number | undefined }[];
  let notified: { method: string; affected: number | undefined }[];
  const listeners = new Map<EntityEventType, (payload: any) => void>();

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [ZrweDoc] });
    for (const event of EVENTS) {
      const listener = (payload: any) => {
        emitted.push({ event, affected: payload.affected });
      };
      listeners.set(event, listener);
      em.on(event, listener);
    }
    const record = (method: string) => (event: DeleteEvent<ZrweDoc>) => {
      notified.push({ method, affected: event.affected });
    };
    const subscriber: EntitySubscriber<ZrweDoc> = {
      listenTo: () => ZrweDoc,
      beforeDelete: record("beforeDelete"),
      afterDelete: record("afterDelete"),
      beforeSoftDelete: record("beforeSoftDelete"),
      afterSoftDelete: record("afterSoftDelete"),
      beforeRestore: record("beforeRestore"),
      afterRestore: record("afterRestore"),
    };
    em.addSubscriber(subscriber);
  });

  afterAll(async () => {
    for (const [event, listener] of listeners) em.off(event, listener);
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    await em.query('DELETE FROM "zrwe_docs"');
    doc = await em.save(ZrweDoc, { title: "a", views: 0 });
    emitted = [];
    notified = [];
  });

  const missing = 999_999;

  it.each([
    ["delete", () => em.delete(ZrweDoc, { id: missing }), "beforeDelete"],
    ["deleteMany", () => em.deleteMany(ZrweDoc, [missing]), "beforeDelete"],
    ["update", () => em.update(ZrweDoc, { id: missing }, { title: "b" }), "beforeUpdate"],
    [
      "updateMany",
      () => em.updateMany(ZrweDoc, { title: "b" }, { where: { id: missing } }),
      "beforeUpdate",
    ],
    ["increment", () => em.increment(ZrweDoc, { id: missing }, "views", 1), "beforeUpdate"],
    ["decrement", () => em.decrement(ZrweDoc, { id: missing }, "views", 1), "beforeUpdate"],
    ["softDelete", () => em.softDelete(ZrweDoc, { id: missing }), "beforeSoftDelete"],
    ["restore", () => em.restore(ZrweDoc, { id: missing }), "beforeRestore"],
  ] as const)("%s that matches no row fires only its before-event", async (_name, write, before) => {
    await expect(write()).resolves.toEqual({ affected: 0 });

    expect(emitted).toEqual([{ event: before, affected: undefined }]);
    if (before !== "beforeUpdate") {
      expect(notified).toEqual([{ method: before, affected: undefined }]);
    }
  });

  it("softDelete of an already trashed row fires no afterSoftDelete", async () => {
    await em.softDelete(ZrweDoc, { id: doc.id });
    emitted = [];
    notified = [];

    await expect(em.softDelete(ZrweDoc, { id: doc.id })).resolves.toEqual({ affected: 0 });

    expect(emitted.map((e) => e.event)).toEqual(["beforeSoftDelete"]);
    expect(notified.map((n) => n.method)).toEqual(["beforeSoftDelete"]);
  });

  it("restore of a live row fires no afterRestore", async () => {
    await expect(em.restore(ZrweDoc, { id: doc.id })).resolves.toEqual({ affected: 0 });

    expect(emitted.map((e) => e.event)).toEqual(["beforeRestore"]);
  });

  it("reports the matched row count on the after-events of writes that matched", async () => {
    const other = await em.save(ZrweDoc, { title: "b", views: 0 });
    emitted = [];
    notified = [];

    await em.updateMany(ZrweDoc, { views: 5 }, { where: { id: [doc.id, other.id] } });
    await em.increment(ZrweDoc, { id: doc.id }, "views", 1);
    await em.softDelete(ZrweDoc, { id: [doc.id, other.id] });
    await em.restore(ZrweDoc, { id: doc.id });
    await em.delete(ZrweDoc, { id: [doc.id, other.id] });

    expect(emitted.filter((e) => e.event.startsWith("after"))).toEqual([
      { event: "afterUpdate", affected: 2 },
      { event: "afterUpdate", affected: 1 },
      { event: "afterSoftDelete", affected: 2 },
      { event: "afterRestore", affected: 1 },
      { event: "afterDelete", affected: 2 },
    ]);
    expect(notified.filter((n) => n.method.startsWith("after"))).toEqual([
      { method: "afterSoftDelete", affected: 2 },
      { method: "afterRestore", affected: 1 },
      { method: "afterDelete", affected: 2 },
    ]);
  });

  it("reports deleteMany's matched row count", async () => {
    await expect(em.deleteMany(ZrweDoc, [doc.id, missing])).resolves.toEqual({ affected: 1 });

    expect(emitted).toEqual([
      { event: "beforeDelete", affected: undefined },
      { event: "afterDelete", affected: 1 },
    ]);
  });
});
