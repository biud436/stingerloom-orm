/**
 * SQLite In-Memory: @RelationColumn 섀도우 속성 @Index() 통합 테스트
 *
 * @RelationColumn({ name: "workspace_id" })만 있고 백킹 @Column이 없는
 * 섀도우 속성(workspaceId)에 @Index()를 걸면, 과거에는 SchemaGenerator의
 * propertyToColumnMap이 FK 섀도우 매핑을 몰라 존재하지 않는 camelCase
 * 컬럼("workspaceId")으로 CREATE INDEX를 방출했고, continueOnError 기본값이
 * 실패를 삼켜 인덱스만 조용히 누락됐습니다.
 *
 * 실제 sqlite_master를 조회해 인덱스가 진짜 FK 컬럼 위에 생성됐는지
 * 검증합니다.
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
  Index,
  ManyToOne,
  RelationColumn,
} from "../../../src";

interface IndexRow {
  name: string;
  sql: string | null;
}

describe("[Integration] SQLite: FK 섀도우 속성 @Index() 실제 생성", () => {
  let conn: TestConnectionResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        @Entity({ name: "fksi_workspaces" })
        class FksiWorkspace {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 100 })
          name!: string;
        }

        @Entity({ name: "fksi_boards" })
        class FksiBoard {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 100 })
          title!: string;

          @ManyToOne(() => FksiWorkspace, (w: FksiWorkspace & { boards?: unknown }) => w.boards)
          @RelationColumn({ name: "workspace_id" })
          workspace!: FksiWorkspace;

          // Documented shadow FK property — no backing @Column
          @Index()
          workspaceId?: number;
        }

        return { entities: [FksiWorkspace, FksiBoard] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("섀도우 속성 인덱스가 실제 FK 컬럼(workspace_id) 위에 생성되어야 함", async () => {
    const indexes = (await conn.em.query(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='fksi_boards' AND sql IS NOT NULL",
    )) as IndexRow[];

    // Before the fix the CREATE INDEX targeted the nonexistent "workspaceId"
    // column, failed, and was swallowed by continueOnError — leaving zero
    // user-defined indexes on the table.
    expect(indexes).toHaveLength(1);
    expect(indexes[0].sql).toContain('"workspace_id"');
    expect(indexes[0].sql).not.toContain("workspaceId");
  });

  it("인덱스가 걸린 FK 컬럼으로 정상 조회되어야 함", async () => {
    const rows = (await conn.em.query(
      "SELECT id FROM fksi_boards WHERE workspace_id IS NULL",
    )) as Array<{ id: number }>;
    expect(Array.isArray(rows)).toBe(true);
  });
});
