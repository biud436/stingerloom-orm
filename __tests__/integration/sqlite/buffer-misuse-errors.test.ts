/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: what the write buffer's own methods throw when they are
 * misused or the row is gone.
 *
 * markDirty / markReadOnly / wrapCollection / refresh / remove / track and
 * getReference threw a bare `Error` with no code, while `em.buffer()` without
 * the plugin and a dangling `getReference()` already threw an `OrmError`. A
 * concurrent delete before `refresh()` is an ordinary application condition,
 * and it was the one an `instanceof EntityNotFoundError` handler could not see.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { EntityNotFoundError } from "../../../src/errors/EntityNotFoundError";

@Entity({ name: "bme_note" })
class BmeNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
}

@Entity({ name: "bme_shape" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind", type: "varchar", length: 20 })
class BmeShape {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
}

@Entity()
@DiscriminatorValue("circle")
class BmeCircle extends BmeShape {
  @Column({ type: "int", nullable: true }) radius!: number | null;
}

@Entity()
@DiscriminatorValue("square")
class BmeSquare extends BmeShape {
  @Column({ type: "int", nullable: true }) side!: number | null;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OrmError);
    return (e as OrmError).code;
  }
  return undefined;
}

describe("[Integration] SQLite: WriteBuffer misuse errors", () => {
  let em: EntityManager;

  beforeEach(async () => {
    em = new EntityManager();
    await em.register({
      type: "sqlite",
      database: ":memory:",
      entities: [BmeNote, BmeShape, BmeCircle, BmeSquare],
      synchronize: true,
      logging: false,
      plugins: [bufferPlugin()],
    } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  function buffer(): WriteBuffer {
    return (em as any).buffer();
  }

  it("reports an instance the buffer does not track as BUFFER_NOT_TRACKED", async () => {
    const buf = buffer();
    const stranger = Object.assign(new BmeNote(), { id: 1, title: "loose" });

    expect(codeOf(() => buf.markDirty(stranger))).toBe(OrmErrorCode.BUFFER_NOT_TRACKED);
    expect(codeOf(() => buf.markReadOnly(stranger))).toBe(OrmErrorCode.BUFFER_NOT_TRACKED);
    expect(codeOf(() => buf.wrapCollection(stranger, "title"))).toBe(OrmErrorCode.BUFFER_NOT_TRACKED);
    const refreshed = await buf.refresh(stranger).catch((e: unknown) => e);
    expect(refreshed).toBeInstanceOf(OrmError);
    expect((refreshed as OrmError).code).toBe(OrmErrorCode.BUFFER_NOT_TRACKED);
    expect((refreshed as OrmError).message).toMatch(/Cannot refresh: instance of "BmeNote" is not tracked/);
  });

  it("refuses to wrap a property that is not an array", async () => {
    const saved = await em.save(BmeNote, { title: "first" });
    const buf = buffer();
    const note = await buf.findOne(BmeNote, { where: { id: saved.id } });

    expect(codeOf(() => buf.wrapCollection(note, "title"))).toBe(OrmErrorCode.INVALID_QUERY);
  });

  it("refuses to track a second instance of a tracked row", async () => {
    const saved = await em.save(BmeNote, { title: "first" });
    const buf = buffer();
    await buf.findOne(BmeNote, { where: { id: saved.id } });
    const copy = Object.assign(new BmeNote(), { id: saved.id, title: "copy" });

    expect(codeOf(() => buf.track(copy))).toBe(OrmErrorCode.BUFFER_IDENTITY_CONFLICT);
  });

  it("refuses a reference to a tracked row under a sibling subtype", async () => {
    const circle = await em.save(BmeCircle, { label: "c", radius: 3 });
    const buf = buffer();
    await buf.findOne(BmeCircle, { where: { id: circle.id } });

    expect(codeOf(() => buf.getReference(BmeSquare, circle.id))).toBe(
      OrmErrorCode.BUFFER_IDENTITY_CONFLICT,
    );
  });

  it("refuses to remove an instance without a primary key", () => {
    const buf = buffer();
    const unsaved = Object.assign(new BmeNote(), { title: "never saved" });

    expect(codeOf(() => buf.remove(unsaved))).toBe(OrmErrorCode.PRIMARY_KEY_NOT_FOUND);
  });

  it("reports a row deleted before refresh() as EntityNotFoundError", async () => {
    const saved = await em.save(BmeNote, { title: "first" });
    const buf = buffer();
    const note = await buf.findOne(BmeNote, { where: { id: saved.id } });
    await em.delete(BmeNote, { id: saved.id });

    const error = await buf.refresh(note).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EntityNotFoundError);
    expect((error as OrmError).code).toBe(OrmErrorCode.ENTITY_NOT_FOUND);
    expect((error as OrmError).message).toMatch(
      new RegExp(`Entity "BmeNote" not found\\. refresh\\(\\) found no row for \\{"id":${saved.id}\\}`),
    );
  });
});
