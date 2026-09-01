/**
 * A ManyToOne property set to a bare key must reach the FK column on every
 * batch write path.
 *
 * `insertMany` / `insertManyAndReturn` bound `{ user: 7 }` straight to the FK
 * column, but the batch INSERT behind `saveMany` treated a non-object,
 * non-null relation value as "nothing to write": it fell through to the
 * `${property}Id` shadow and, finding none, bound NULL. The caller's foreign
 * key was dropped without a word, so a batch of rows landed unparented.
 *
 * Found while decomposing the batch write methods — the three paths carried
 * three near-copies of the same row builder, and only one of them was wrong.
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  RelationColumn,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "smfk_authors" })
class SmfkAuthor {
  @PrimaryColumn({ type: "int" })
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;
}

/** Generated PK, so saveMany takes the batch INSERT path rather than the per-item fallback. */
@Entity({ name: "smfk_notes" })
class SmfkNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @ManyToOne(() => SmfkAuthor, () => undefined)
  @RelationColumn({ name: "authorId" })
  author!: SmfkAuthor;
}

@Entity({ name: "smfk_posts" })
class SmfkPost {
  @PrimaryColumn({ type: "int" })
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @ManyToOne(() => SmfkAuthor, () => undefined)
  @RelationColumn({ name: "authorId" })
  author!: SmfkAuthor;
}

type StoredPost = { id: number; title: string; authorId: number | null };

describe("[Integration] SQLite: batch writes keep a scalar ManyToOne key", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [SmfkAuthor, SmfkPost, SmfkNote],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    await em.query("DELETE FROM smfk_posts");
    await em.query("DELETE FROM smfk_notes");
    await em.query("DELETE FROM smfk_authors");
    await em.save(SmfkAuthor, { id: 7, name: "author-7" } as never);
  });

  async function storedPosts(): Promise<StoredPost[]> {
    return (await em.query(
      "SELECT id, title, authorId FROM smfk_posts ORDER BY id",
    )) as unknown as StoredPost[];
  }

  it("writes the key given as a bare value through the per-item save path", async () => {
    await em.saveMany(SmfkPost, [
      { id: 1, title: "first", author: 7 },
      { id: 2, title: "second", author: 7 },
    ] as never);

    const rows = await storedPosts();
    expect(rows.map((r) => r.authorId)).toEqual([7, 7]);
  });

  it("writes the key given as a bare value through the batch INSERT path", async () => {
    // A generated PK routes saveMany through saveManyBatchInsert; the assigned
    // PK entity above exercises the per-item fallback. Both must agree.
    await em.saveMany(SmfkNote, [
      { title: "batched", author: 7 },
      { title: "batched too", author: 7 },
    ] as never);

    const rows = (await em.query(
      "SELECT id, title, authorId FROM smfk_notes ORDER BY id",
    )) as unknown as StoredPost[];
    expect(rows.map((r) => r.authorId)).toEqual([7, 7]);
  });

  it("writes the key given as a bare value through insertMany", async () => {
    await em.insertMany(SmfkPost, [
      { id: 3, title: "third", author: 7 },
    ] as never);

    const rows = await storedPosts();
    expect(rows.map((r) => r.authorId)).toEqual([7]);
  });

  it("writes the key given as a bare value through insertManyAndReturn", async () => {
    await em.insertManyAndReturn(SmfkPost, [
      { id: 4, title: "fourth", author: 7 },
    ] as never);

    const rows = await storedPosts();
    expect(rows.map((r) => r.authorId)).toEqual([7]);
  });

  it("still accepts a related instance and the FK shadow property", async () => {
    const author = await em.findOne(SmfkAuthor, { where: { id: 7 } });

    await em.saveMany(SmfkPost, [
      { id: 5, title: "by instance", author },
      { id: 6, title: "by shadow", authorId: 7 },
    ] as never);

    const rows = await storedPosts();
    expect(rows.map((r) => r.authorId)).toEqual([7, 7]);
  });

  it("still writes NULL when the relation is explicitly null", async () => {
    await em.saveMany(SmfkPost, [
      { id: 8, title: "orphan", author: null },
    ] as never);

    const rows = await storedPosts();
    expect(rows.map((r) => r.authorId)).toEqual([null]);
  });
});
