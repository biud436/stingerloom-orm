/**
 * The batch INSERT behind `saveMany` re-reads the inserted rows by their
 * derived primary keys (always, when the entity has an eager relation). That
 * re-read used to drop any key it could not find, so `saveMany` returned a
 * shorter array than it was given without a word:
 *
 *   1. a row inserted with its `@DeletedAt` already set was filtered out by the
 *      re-read's soft-delete predicate, although it had been saved;
 *   2. a row that could not be read back at all was silently missing from the
 *      result instead of failing the call.
 */
import "reflect-metadata";
import {
  Column,
  DeletedAt,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { OrmError } from "../../../src/errors/OrmError";

@Entity({ name: "smrl_groups" })
class SmrlGroup {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;
}

/** Generated PK + an eager relation, so saveMany takes the batch INSERT and its re-read. */
@Entity({ name: "smrl_items" })
class SmrlItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @Column({ type: "int", nullable: true })
  groupId!: number | null;

  @DeletedAt()
  deletedAt!: Date | null;

  @ManyToOne(() => SmrlGroup, () => undefined, { joinColumn: "groupId", eager: true })
  group!: SmrlGroup | null;
}

describe("[Integration] SQLite: saveMany returns every row its batch INSERT wrote", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [SmrlGroup, SmrlItem] });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    await em.query("DROP TRIGGER IF EXISTS smrl_vanish");
    await em.query("DELETE FROM smrl_items");
    await em.query("DELETE FROM smrl_groups");
  });

  it("returns a row inserted already soft-deleted", async () => {
    const saved = await em.saveMany(SmrlItem, [
      { name: "live" },
      { name: "trashed", deletedAt: new Date("2026-01-02T03:04:05Z") },
    ] as never);

    expect(saved.map((item) => item.name)).toEqual(["live", "trashed"]);
    expect(saved[1].deletedAt).toBeInstanceOf(Date);
  });

  it("fails instead of returning a short array when a row cannot be read back", async () => {
    // The trigger removes one row right after it is inserted, so the re-read
    // by derived primary key finds one of the two.
    await em.query(
      "CREATE TRIGGER smrl_vanish AFTER INSERT ON smrl_items WHEN NEW.name = 'ghost' " +
        "BEGIN DELETE FROM smrl_items WHERE id = NEW.id; END",
    );

    await expect(
      em.saveMany(SmrlItem, [{ name: "kept" }, { name: "ghost" }] as never),
    ).rejects.toThrow(OrmError);
    await expect(
      em.saveMany(SmrlItem, [{ name: "kept" }, { name: "ghost" }] as never),
    ).rejects.toThrow(/inserted 2 rows but could not read back 1 of them/);

    const rows = (await em.query("SELECT name FROM smrl_items")) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });
});
