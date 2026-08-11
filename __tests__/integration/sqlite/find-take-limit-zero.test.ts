/**
 * SQLite In-Memory: take/limit 0 must mean LIMIT 0, not "no limit" (V4-T0-2 a).
 *
 * The scalar take/limit paths used falsy fallbacks (`(take ?? 0) || undefined`,
 * `if (limit)`), so an explicit 0 silently dropped the LIMIT clause and the
 * query returned the whole table. The validator has always allowed 0, the
 * tuple form already treats a 0 count as LIMIT 0, and SelectQueryBuilder's
 * take(0) emits LIMIT 0 — this pins the FindOption scalar forms to the same
 * contract.
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
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: find() take/limit 0", () => {
  let conn: TestConnectionResult;
  let Todo: any;
  const table = `take_zero_${String(Date.now()).slice(-6)}`;

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

        @Entity({ name: table })
        class TodoEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
        }

        Todo = TodoEntity;
        return { entities: [TodoEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${table}"`);
    await conn.em.save(Todo, { title: "a" });
    await conn.em.save(Todo, { title: "b" });
    await conn.em.save(Todo, { title: "c" });
  });

  describe("explicit 0 means LIMIT 0", () => {
    it("take: 0 → 0행 (수정 전: LIMIT이 사라져 전체 3행 반환)", async () => {
      const rows = await conn.em.find(Todo, { take: 0 });
      expect(rows).toEqual([]);
    });

    it("limit: 0 → 0행 (수정 전: LIMIT이 사라져 전체 3행 반환)", async () => {
      const rows = await conn.em.find(Todo, { limit: 0 });
      expect(rows).toEqual([]);
    });

    it("skip: 1 + take: 0 → 0행 (수정 전: OFFSET만 적용되어 2행 반환)", async () => {
      const rows = await conn.em.find(Todo, { skip: 1, take: 0 });
      expect(rows).toEqual([]);
    });

    it("튜플 limit: [1, 0] → 0행 (기왕 동작하던 계약 핀)", async () => {
      const rows = await conn.em.find(Todo, { limit: [1, 0] });
      expect(rows).toEqual([]);
    });
  });

  describe("무회귀", () => {
    it("take: 2 → 2행", async () => {
      const rows = await conn.em.find(Todo, {
        take: 2,
        orderBy: { id: "ASC" },
      });
      expect(rows.map((r: any) => r.title)).toEqual(["a", "b"]);
    });

    it("limit: 2 → 2행", async () => {
      const rows = await conn.em.find(Todo, {
        limit: 2,
        orderBy: { id: "ASC" },
      });
      expect(rows.map((r: any) => r.title)).toEqual(["a", "b"]);
    });

    it("skip: 1 단독 → 나머지 2행 (take 없는 offset 폴백 유지)", async () => {
      const rows = await conn.em.find(Todo, {
        skip: 1,
        orderBy: { id: "ASC" },
      });
      expect(rows.map((r: any) => r.title)).toEqual(["b", "c"]);
    });

    it("take/limit 미지정 → 전체 3행", async () => {
      const rows = await conn.em.find(Todo, {});
      expect(rows.length).toBe(3);
    });
  });
});
