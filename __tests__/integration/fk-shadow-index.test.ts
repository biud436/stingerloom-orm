/**
 * @RelationColumn 섀도우 속성 @Index() 실 DB 통합 테스트 (MySQL / PostgreSQL)
 *
 * 백킹 @Column 없이 @RelationColumn({ name: "workspace_id" })만 있는 섀도우
 * 속성(workspaceId)에 @Index()를 걸었을 때, 인덱스가 camelCase 속성명이 아닌
 * 실제 FK 컬럼 위에 생성되는지 실 DB 카탈로그로 검증합니다.
 * (수정 전: 존재하지 않는 "workspaceId" 컬럼 대상 CREATE INDEX가 실패하고
 * continueOnError가 삼켜 인덱스만 조용히 누락)
 *
 * 실행:
 *   INTEGRATION_TEST=true npx jest --testPathPattern="fk-shadow-index"
 */
import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  ManyToOne,
  RelationColumn,
} from "../../src";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import { getIndexesSql } from "./helpers/driver-helpers";

const SUFFIX = Date.now().toString().slice(-7);

describe.each(getTestDrivers())(
  "[Integration] FK 섀도우 속성 @Index() 실제 생성 ($label)",
  (driverConfig: TestDriverConfig) => {
  const wsTable = `fksi_ws_${SUFFIX}`;
  const boardTable = `fksi_board_${SUFFIX}`;
  let conn: TestConnectionResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...driverConfig.options, synchronize: true, logging: false },
      () => {
        @Entity({ name: wsTable })
        class FksiWorkspace {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 100 })
          name!: string;
        }

        @Entity({ name: boardTable })
        class FksiBoard {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 100 })
          title!: string;

          @ManyToOne(
            () => FksiWorkspace,
            (w: FksiWorkspace & { boards?: unknown }) => w.boards,
          )
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
    await dropTestTable(boardTable);
    await dropTestTable(wsTable);
    await conn.cleanup();
  });

  it("섀도우 속성 인덱스가 실제 FK 컬럼(workspace_id) 위에 생성되어야 함", async () => {
    const rows = (await conn.em.query(
      getIndexesSql(driverConfig.type, boardTable),
    )) as Array<Record<string, unknown>>;

    if (driverConfig.type === "postgres") {
      const defs = rows.map((r) => String(r.indexdef));
      const shadowIndex = defs.find((d) => d.includes("workspace_id"));
      expect(shadowIndex).toBeDefined();
      expect(defs.some((d) => d.includes("workspaceId"))).toBe(false);
    } else {
      const indexed = rows.map((r) => String(r.Column_name));
      expect(indexed).toContain("workspace_id");
      expect(indexed).not.toContain("workspaceId");
    }
  });
  },
);
