/**
 * SQLite In-Memory: findWithCursor keyset 무손실 계약.
 *
 * 커서 페이지네이션은 어떤 orderBy 컬럼에서도 전 행을 정확히 한 번씩
 * 방문해야 한다. 종전 구현은
 *
 *   1) 순수 `col > cursor` 비교만 사용 (PK 타이브레이커 없음)
 *      → 페이지 경계에 동일 값이 걸치면 나머지 동값 행 전부 누락
 *   2) `OR col IS NULL`을 매 페이지 포함 + 방언별 NULL 정렬 차이
 *      (SQLite/MySQL ASC는 NULL 먼저, PG는 NULL 나중)
 *      → 이미 반환한 NULL 행이 중복되거나
 *   3) 마지막 행이 NULL이면 encodeCursor(null) → 다음 호출이
 *      "Invalid cursor"로 즉사
 *
 * 새 계약: ORDER BY (col IS NULL, col, pk) — ASC는 NULL 마지막 /
 * DESC는 NULL 먼저 (전 방언 동일) — + 커서에 (orderValue, pk) 튜플.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: findWithCursor keyset 무손실", () => {
  let conn: TestConnectionResult;
  let Item: new () => any;
  const itemTable = shortName("ck_item");

  /** 커서를 따라 끝까지 순회하며 (id, age) 목록을 수집한다. */
  async function iterateAll(
    option: Record<string, unknown>,
  ): Promise<Array<{ id: number; age: number | null }>> {
    const em = conn.em;
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
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor;
    }
    return seen;
  }

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: itemTable })
        class ItemEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int", nullable: true }) age!: number | null;
          @Column() label!: string;
        }

        Item = ItemEntity;
        return { entities: [ItemEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    const driver = conn.em.getDriver()!;
    await driver.executeRaw(`DELETE FROM "${itemTable}"`);
  });

  async function seed(ages: Array<number | null>): Promise<void> {
    for (let i = 0; i < ages.length; i++) {
      await conn.em.save(Item, { age: ages[i], label: `row${i}` } as any);
    }
  }

  it("동일 값이 페이지 경계에 걸쳐도 행이 누락되지 않는다 (ASC)", async () => {
    await seed([10, 10, 10, 20, 20]);
    const seen = await iterateAll({ orderBy: "age", direction: "ASC" });
    expect(seen.length).toBe(5);
    expect(new Set(seen.map((s) => s.id)).size).toBe(5);
    expect(seen.map((s) => s.age)).toEqual([10, 10, 10, 20, 20]);
  });

  it("전 행이 같은 값이어도 전부 정확히 한 번씩 순회한다", async () => {
    await seed([7, 7, 7, 7, 7]);
    const seen = await iterateAll({ orderBy: "age", direction: "ASC" });
    expect(seen.length).toBe(5);
    expect(new Set(seen.map((s) => s.id)).size).toBe(5);
  });

  it("NULL 값 행도 중복/누락 없이 순회하고 ASC에서 마지막에 온다", async () => {
    await seed([null, null, 10, 20]);
    const seen = await iterateAll({ orderBy: "age", direction: "ASC" });
    expect(seen.length).toBe(4);
    expect(new Set(seen.map((s) => s.id)).size).toBe(4);
    // 방언 무관 계약: ASC는 NULL이 마지막
    expect(seen.map((s) => s.age)).toEqual([10, 20, null, null]);
  });

  it("DESC: 중복 + NULL 조합도 무손실, NULL이 먼저 온다", async () => {
    await seed([10, 10, null, 20, null]);
    const seen = await iterateAll({ orderBy: "age", direction: "DESC" });
    expect(seen.length).toBe(5);
    expect(new Set(seen.map((s) => s.id)).size).toBe(5);
    expect(seen.map((s) => s.age)).toEqual([null, null, 20, 10, 10]);
  });

  it("PK 기본 정렬(기존 경로)은 그대로 동작한다 (sanity)", async () => {
    await seed([1, 2, 3, 4, 5]);
    const seen = await iterateAll({});
    expect(seen.length).toBe(5);
    expect(seen.map((s) => s.age)).toEqual([1, 2, 3, 4, 5]);
  });

  it("레거시 스칼라 커서({v}만)도 전환 페이지로 수용된다", async () => {
    await seed([10, 20, 30, 40]);
    // 종전 인코딩: { v: <마지막 orderBy 값> }
    const legacyCursor = Buffer.from(JSON.stringify({ v: 20 }), "utf-8").toString(
      "base64",
    );
    const page: any = await conn.em.findWithCursor(Item, {
      orderBy: "age",
      direction: "ASC",
      take: 10,
      cursor: legacyCursor,
    } as any);
    expect(page.data.map((r: any) => r.age)).toEqual([30, 40]);
  });
});
