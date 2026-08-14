/**
 * PostgreSQL (real server): `type: "array"` 컬럼 E2E.
 *
 * 수정 전에는 PG DDL이 요소 타입 없는 `ARRAY` 플레이스홀더를 그대로 방출해
 * CREATE TABLE이 42601(syntax error)로 실패했고, continueOnError 기본값이
 * 이를 삼켜 테이블 없이 부팅되는 무음 실패였습니다 (2026-08-14 실 PG 확정).
 *
 * 검증:
 *  - synchronize:true 부팅으로 array 컬럼 테이블이 실제 생성 (TEXT[] 기본,
 *    arrayElementType: "int" → INTEGER[])
 *  - information_schema data_type/udt_name 확인
 *  - JS 배열 값 save → find 왕복 (pg 네이티브 배열 직렬화)
 *
 * Run:
 *   INTEGRATION_TEST=true PG_HOST=192.168.35.227 \
 *     npx jest --testPathPattern="postgres-array-column"
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const INTEGRATION =
  process.env.INTEGRATION_TEST === "true" &&
  process.env.INTEGRATION_TEST_POSTGRES !== "false";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

const PG_BASE: Partial<DatabaseClientOptions> = {
  type: "postgres",
  host: process.env.PG_HOST || "192.168.35.227",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

const SFX = String(Date.now()).slice(-7);
const TABLE = `arr_col_${SFX}`;

interface ArrayPostShape {
  id: number;
  tags: string[] | null;
  scores: number[] | null;
}

integrationDescribe("[Integration][Postgres] array 컬럼 E2E", () => {
  let conn: TestConnectionResult;
  let ArrayPost: new () => ArrayPostShape;

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...PG_BASE, synchronize: true, logging: false },
      () => {
        @Entity({ name: TABLE })
        class ArrayPostEntity {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "array", nullable: true })
          tags!: string[] | null;

          @Column({ type: "array", arrayElementType: "int", nullable: true })
          scores!: number[] | null;
        }
        ArrayPost = ArrayPostEntity;
        return { entities: [ArrayPostEntity] };
      },
    );
  });

  afterAll(async () => {
    await dropTestTable(TABLE);
    await conn.cleanup();
  });

  it("synchronize가 array 컬럼 테이블을 실제로 생성해야 함", async () => {
    const cols = (await conn.em.query(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_name = '${TABLE}' ORDER BY ordinal_position`,
    )) as Array<{ column_name: string; data_type: string; udt_name: string }>;

    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(byName["tags"]).toMatchObject({
      data_type: "ARRAY",
      udt_name: "_text",
    });
    expect(byName["scores"]).toMatchObject({
      data_type: "ARRAY",
      udt_name: "_int4",
    });
  });

  it("JS 배열 값이 save → find로 왕복되어야 함", async () => {
    const post = new ArrayPost();
    post.tags = ["orm", "postgres", "array"];
    post.scores = [10, 20, 30];
    const saved = await conn.em.save(ArrayPost, post);

    const found = await conn.em.findOne(ArrayPost, {
      where: { id: saved.id },
    });
    expect(found?.tags).toEqual(["orm", "postgres", "array"]);
    expect(found?.scores).toEqual([10, 20, 30]);
  });

  it("빈 배열과 NULL이 구분되어 왕복되어야 함", async () => {
    const empty = new ArrayPost();
    empty.tags = [];
    empty.scores = null;
    const saved = await conn.em.save(ArrayPost, empty);

    const found = await conn.em.findOne(ArrayPost, {
      where: { id: saved.id },
    });
    expect(found?.tags).toEqual([]);
    expect(found?.scores).toBeNull();
  });
});
