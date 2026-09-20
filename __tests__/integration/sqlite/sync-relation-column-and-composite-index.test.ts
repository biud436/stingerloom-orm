/**
 * Synchronize-time coverage for two schema details that used to be dropped:
 *
 * 1. `@RelationColumn({ nullable: false, type })` — the FK column was always
 *    created as a NULL-able column of the target PK's type.
 * 2. class-level `@Index([...])` — composite indexes existed in generated
 *    migrations but were never created by synchronize.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Index } from "../../../src/decorators/Indexer";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "srci_authors" })
class Author {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 120 })
  name!: string;
}

@Entity({ name: "srci_books" })
@Index(["title", "publishedAt"], "idx_srci_books_title_published")
class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "datetime", name: "published_at" })
  publishedAt!: Date;

  @ManyToOne(() => Author, (author: any) => author.books)
  @RelationColumn({ name: "author_id", type: "int", nullable: false })
  author!: Author;

  @ManyToOne(() => Author, (author: any) => author.reviewed)
  @RelationColumn({ name: "reviewer_id", type: "int", nullable: true })
  reviewer!: Author;
}

describe("[Integration] SQLite: relation column + composite index synchronize", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [Author, Book] });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  it("creates the FK column with the declared type and NOT NULL", async () => {
    const columns = (await em.query('PRAGMA table_info("srci_books")')) as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    const authorId = columns.find((c) => c.name === "author_id");
    const reviewerId = columns.find((c) => c.name === "reviewer_id");

    expect(authorId).toBeDefined();
    expect(authorId!.notnull).toBe(1);
    // The nullable relation keeps its NULL — only the declared flag is honored.
    expect(reviewerId!.notnull).toBe(0);
  });

  it("creates the class-level composite index", async () => {
    const indexes = (await em.query('PRAGMA index_list("srci_books")')) as Array<{
      name: string;
    }>;
    const composite = indexes.find(
      (i) => i.name === "idx_srci_books_title_published",
    );
    expect(composite).toBeDefined();

    const info = (await em.query(
      'PRAGMA index_info("idx_srci_books_title_published")',
    )) as Array<{ name: string; seqno: number }>;
    expect(
      info.sort((a, b) => a.seqno - b.seqno).map((r) => r.name),
    ).toEqual(["title", "published_at"]);
  });
});
