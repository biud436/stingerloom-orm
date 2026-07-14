/**
 * SQLite In-Memory: updateMany() with raw Sql expressions in SET (issue #404).
 *
 * Backfills __tests__/unit/update-many-sql-expression.test.ts, which asserts
 * only that the generated SQL STRING contains "pos + 1" against a mocked
 * session — the statement is never executed, so a builder bug that
 * parameterizes the expression, maps it to the wrong column, or applies it
 * twice would corrupt every matched row while the unit test stays green.
 * Here the same scenarios run against a real database and assert row state.
 */

import "reflect-metadata";
import sql from "sql-template-tag";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  UpdateTimestamp,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: updateMany with Sql expressions in SET", () => {
  let conn: TestConnectionResult;
  let Comment: any;
  let Doc: any;
  const commentTable = `ume_comment_${String(Date.now()).slice(-6)}`;
  const docTable = `ume_doc_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: commentTable })
        class CommentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) pos!: number;
          @Column() content!: string;
          @Column({ type: "int" }) postId!: number;
        }

        @Entity({ name: docTable })
        class DocEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) hits!: number;
          @UpdateTimestamp() updatedAt!: Date;
        }

        Comment = CommentEntity;
        Doc = DocEntity;
        return { entities: [CommentEntity, DocEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${commentTable}"`);
    await conn.em.query(`DELETE FROM "${docTable}"`);
  });

  async function commentRows(): Promise<any[]> {
    return (await conn.em.query(
      `SELECT "id", "pos", "content", "postId" FROM "${commentTable}" ORDER BY "id"`,
    )) as any[];
  }

  it("applies a self-referential expression (pos = pos + 1) to matched rows only", async () => {
    await conn.em.save(Comment, { pos: 1, content: "a", postId: 5 } as any);
    await conn.em.save(Comment, { pos: 2, content: "b", postId: 5 } as any);
    await conn.em.save(Comment, { pos: 3, content: "c", postId: 5 } as any);
    await conn.em.save(Comment, { pos: 9, content: "other", postId: 7 } as any);

    const result = await conn.em.updateMany(
      Comment,
      { pos: sql`pos + 1` } as any,
      { where: { postId: 5 } as any },
    );
    expect(result.affected).toBe(3);

    const rows = await commentRows();
    // Each matched row incremented exactly once, relative to ITS OWN value;
    // the non-matched row (postId 7) is untouched.
    expect(rows.map((r) => r.pos)).toEqual([2, 3, 4, 9]);
  });

  it("applies mixed literal values and Sql expressions in one statement", async () => {
    await conn.em.save(Comment, { pos: 10, content: "before", postId: 1 } as any);
    await conn.em.save(Comment, { pos: 20, content: "before", postId: 1 } as any);

    await conn.em.updateMany(
      Comment,
      { content: "moved", pos: sql`pos + 100` } as any,
      { where: { postId: 1 } as any },
    );

    const rows = await commentRows();
    expect(rows.map((r) => r.pos)).toEqual([110, 120]);
    expect(rows.map((r) => r.content)).toEqual(["moved", "moved"]);
  });

  it("coexists with the automatic @UpdateTimestamp column", async () => {
    const seeded: any = await conn.em.save(Doc, { hits: 1 } as any);
    // Backdate the timestamp so the auto-stamp is observable.
    await conn.em.query(
      `UPDATE "${docTable}" SET "updatedAt" = '2000-01-01 00:00:00' WHERE "id" = ?`,
      [seeded.id],
    );

    await conn.em.updateMany(
      Doc,
      { hits: sql`hits + 1` } as any,
      { where: { id: seeded.id } as any },
    );

    const rows = (await conn.em.query(
      `SELECT "hits", "updatedAt" FROM "${docTable}" WHERE "id" = ?`,
      [seeded.id],
    )) as any[];
    expect(rows[0].hits).toBe(2);
    // The expression must not suppress the @UpdateTimestamp auto-stamp.
    expect(String(rows[0].updatedAt)).not.toContain("2000-01-01");
  });
});
