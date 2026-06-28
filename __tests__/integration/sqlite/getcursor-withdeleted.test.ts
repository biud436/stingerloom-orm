/**
 * SQLite In-Memory: SelectQueryBuilder.getCursor() honors the `withDeleted`
 * option.
 *
 * Regression: getCursor() accepted `withDeleted` in CursorPaginationOption but
 * never applied it, so soft-deleted rows were always filtered out — diverging
 * from EntityManager.findWithCursor(), which honors the same option.
 */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  DeletedAt,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: SelectQueryBuilder.getCursor() withDeleted", () => {
  let conn: TestConnectionResult;
  let Post: new () => { id: number; title: string };
  let table: string;

  beforeAll(async () => {
    table = `cur_sd_${String(Date.now()).slice(-6)}`;

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

        @Entity({ name: table })
        class PostEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          @DeletedAt() deletedAt!: Date | null;
        }

        Post = PostEntity;
        return { entities: [PostEntity] };
      },
    );

    await conn.em.saveMany(Post, [
      { title: "a" },
      { title: "b" },
      { title: "c" },
    ] as any);
    // Soft-delete the middle row.
    await conn.em.softDelete(Post, { title: "b" } as any);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("excludes soft-deleted rows by default", async () => {
    const res = await conn.em
      .createQueryBuilder(Post, "p")
      .getCursor({ take: 10, orderBy: "id" });
    const titles = res.data.map((r: any) => r.title).sort();
    expect(titles).toEqual(["a", "c"]);
  });

  it("includes soft-deleted rows when withDeleted: true is passed", async () => {
    const res = await conn.em
      .createQueryBuilder(Post, "p")
      .getCursor({ take: 10, orderBy: "id", withDeleted: true });
    const titles = res.data.map((r: any) => r.title).sort();
    expect(titles).toEqual(["a", "b", "c"]);
  });

  it("still excludes soft-deleted rows when withDeleted is omitted (no leak)", async () => {
    const res = await conn.em
      .createQueryBuilder(Post, "p")
      .getCursor({ take: 10, orderBy: "id", withDeleted: false });
    const titles = res.data.map((r: any) => r.title).sort();
    expect(titles).toEqual(["a", "c"]);
  });
});
