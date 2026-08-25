/**
 * findWithCursor keyset 무손실 계약 — 실 DB (MySQL/MariaDB + PostgreSQL).
 *
 * 방언 민감부를 실제 서버에서 검증한다:
 *   - `(col IS NULL)` ORDER BY 키 — MySQL은 0/1, PG는 boolean 정렬
 *   - NULL 영역 위치 계약 (ASC = 마지막, DESC = 먼저) — PG의 기본
 *     NULLS LAST와 MySQL의 NULL 먼저가 이 키로 통일되는지
 *   - (orderValue, pk) 튜플 커서 술어의 무손실 순회
 *
 * SQLite 미러: __tests__/integration/sqlite/cursor-pagination-keyset.test.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const drivers = getTestDrivers();

const TABLE = "ck_keyset_item";

describe.each(drivers)(
  "[Integration] $label: findWithCursor keyset 무손실",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Item: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLE })
          class KeysetItem {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int", nullable: true }) age!: number | null;
            @Column() label!: string;
          }
          Item = KeysetItem;
          return { entities: [KeysetItem] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(TABLE);
      } catch {
        // ignore
      }
      await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await truncateTestTable(TABLE);
    });

    async function seed(ages: Array<number | null>): Promise<void> {
      for (let i = 0; i < ages.length; i++) {
        await em.save(Item, { age: ages[i], label: `row${i}` } as any);
      }
    }

    async function iterateAll(
      option: Record<string, unknown>,
    ): Promise<Array<{ id: number; age: number | null }>> {
      const seen: Array<{ id: number; age: number | null }> = [];
      let cursor: string | undefined;
      let guard = 0;
      for (;;) {
        if (++guard > 20) throw new Error("cursor iteration did not terminate");
        const page: any = await em.findWithCursor(Item, {
          ...option,
          take: 2,
          cursor,
        } as any);
        for (const row of page.data) seen.push({ id: row.id, age: row.age });
        if (!page.hasNextPage) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        cursor = page.nextCursor;
      }
      return seen;
    }

    it("동일 값이 페이지 경계에 걸쳐도 행이 누락되지 않는다 (ASC)", async () => {
      await seed([10, 10, 10, 20, 20]);
      const seen = await iterateAll({ orderBy: "age", direction: "ASC" });
      expect(seen.length).toBe(5);
      expect(new Set(seen.map((s) => s.id)).size).toBe(5);
      expect(seen.map((s) => s.age)).toEqual([10, 10, 10, 20, 20]);
    });

    it("NULL 값 행도 중복/누락 없이 순회하고 ASC에서 마지막에 온다", async () => {
      await seed([null, null, 10, 20]);
      const seen = await iterateAll({ orderBy: "age", direction: "ASC" });
      expect(seen.length).toBe(4);
      expect(new Set(seen.map((s) => s.id)).size).toBe(4);
      expect(seen.map((s) => s.age)).toEqual([10, 20, null, null]);
    });

    it("DESC: 중복 + NULL 조합도 무손실, NULL이 먼저 온다", async () => {
      await seed([10, 10, null, 20, null]);
      const seen = await iterateAll({ orderBy: "age", direction: "DESC" });
      expect(seen.length).toBe(5);
      expect(new Set(seen.map((s) => s.id)).size).toBe(5);
      expect(seen.map((s) => s.age)).toEqual([null, null, 20, 10, 10]);
    });

    it("PK 기본 정렬 경로는 그대로 동작한다 (sanity)", async () => {
      await seed([1, 2, 3]);
      const seen = await iterateAll({});
      expect(seen.map((s) => s.age)).toEqual([1, 2, 3]);
    });
  },
);

// Skip-marker so jest reports gracefully when INTEGRATION_TEST is unset.
if (drivers.length === 0) {
  describe.skip("[Integration] cursor keyset — skipped (set INTEGRATION_TEST=true)", () => {
    it("is disabled", () => {
      expect(true).toBe(true);
    });
  });
}
