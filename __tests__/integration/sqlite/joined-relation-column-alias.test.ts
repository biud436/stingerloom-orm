/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A find() that JOINs a to-one relation keeps the reading entity's own
 * columns apart from the related row's.
 *
 * The JOINed columns were aliased `<relation>_<column>`, so the related
 * primary key of `author` came back as `author_id` — the name of the
 * entity's own join column. The row held a single `author_id`, the JOINed
 * one, and a JOIN that found no row (the author soft-deleted) read the stored
 * key back as NULL. Any other column named `<relation>_<x>` (a
 * `${property}Id` @Column called `author_fk`, an `author_note`) was also
 * folded into the related object as `fk` / `note`.
 */
import "reflect-metadata";
import {
  Column,
  DeletedAt,
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "jra_author" })
class JraAuthor {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "jra_book" })
class JraBook {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;

  @Column({ name: "author_note", type: "varchar", nullable: true })
  authorNote!: string | null;

  @ManyToOne(() => JraAuthor, () => undefined)
  @RelationColumn({ name: "author_id" })
  author!: JraAuthor | null;
}

@Entity({ name: "jra_note" })
class JraNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;

  @Column({ name: "author_fk", type: "int", nullable: true })
  authorId!: number | null;

  @ManyToOne(() => JraAuthor, () => undefined)
  author!: JraAuthor | null;
}

@Entity({ name: "jra_badge" })
class JraBadge {
  @PrimaryGeneratedColumn() id!: number;

  @OneToOne(() => JraAuthor, { eager: true })
  @RelationColumn({ name: "holder_id" })
  holder!: JraAuthor | null;
}

describe("[Integration] SQLite: JOINed relation columns do not collide with the entity's own", () => {
  let em: EntityManager;
  let author: JraAuthor;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [JraAuthor, JraBook, JraNote, JraBadge],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    for (const table of ["jra_book", "jra_note", "jra_badge", "jra_author"]) {
      await em.query(`DELETE FROM ${table}`);
    }
    author = await em.save(JraAuthor, { name: "a" });
  });

  describe("a JOIN that finds no row keeps the stored key", () => {
    it("@ManyToOne", async () => {
      const { id } = await em.save(JraBook, { title: "t", author });
      await em.softDelete(JraAuthor, { id: author.id });

      const book = (await em.findOne(JraBook, {
        where: { id },
        relations: ["author"],
      })) as any;

      expect(book.author).toBeNull();
      expect(book.authorId).toBe(author.id);
    });

    it("eager @OneToOne", async () => {
      const { id } = await em.save(JraBadge, { holder: author });
      await em.softDelete(JraAuthor, { id: author.id });

      const badge = (await em.findOne(JraBadge, { where: { id } })) as any;

      expect(badge.holder).toBeNull();
      expect(badge.holderId).toBe(author.id);
    });
  });

  it("a column named after the relation stays on the entity", async () => {
    const { id } = await em.save(JraBook, {
      title: "t",
      authorNote: "signed",
      author,
    });

    const book = await em.findOne(JraBook, { where: { id }, relations: ["author"] });

    expect(book?.authorNote).toBe("signed");
    expect({ ...book?.author }).toEqual({ id: author.id, name: "a", deletedAt: null });
  });

  it("a ${property}Id @Column is not read into the related object", async () => {
    const { id } = await em.save(JraNote, { title: "t", author });

    const note = await em.findOne(JraNote, { where: { id }, relations: ["author"] });

    expect(note?.authorId).toBe(author.id);
    expect({ ...note?.author }).toEqual({ id: author.id, name: "a", deletedAt: null });
  });
});
