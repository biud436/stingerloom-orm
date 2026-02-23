/**
 * Upsert 통합 테스트
 *
 * 실제 MySQL 데이터베이스에 연결하여 EntityManager의 upsert() 메서드를 검증합니다.
 * INSERT ON DUPLICATE KEY UPDATE (MySQL) / INSERT ON CONFLICT DO UPDATE (PostgreSQL) 동작 확인.
 *
 * 실행 전 필요 사항:
 * - MySQL 서버 실행 중
 * - examples/nestjs-cats/.env의 연결 정보가 유효
 * - INTEGRATION_TEST=true 환경변수 설정
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  createDynamicEntity,
  DynamicEntityResult,
} from "./helpers/create-test-entity";

const SKIP = process.env.INTEGRATION_TEST !== "true";

(SKIP ? describe.skip : describe)("[Integration] Upsert 테스트", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        testEntity = createDynamicEntity("upsert_test", [
          { name: "id", designType: Number, primary: true },
          { name: "slug", designType: String, options: { type: "varchar", length: 255 } },
          { name: "title", designType: String, options: { type: "varchar", length: 255 } },
          { name: "viewCount", designType: Number, options: { type: "int", nullable: true } },
        ]);
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;

    // slug 컬럼에 UNIQUE 인덱스 추가 (upsert 충돌 감지에 필요)
    await rawQuery(
      `CREATE UNIQUE INDEX \`uq_${testEntity.tableName}_slug\` ON \`${testEntity.tableName}\` (\`slug\`)`,
    );
  }, 30000);

  afterAll(async () => {
    try {
      await dropTestTable(testEntity.tableName);
    } catch {
      // ignore
    }
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    await truncateTestTable(testEntity.tableName);
  });

  // ─────────────────────────────────────────────────────────
  // INSERT (충돌 키가 존재하지 않는 경우)
  // ─────────────────────────────────────────────────────────

  it("should insert a new record when conflict key does not exist", async () => {
    await em.upsert(
      testEntity.EntityClass,
      { slug: "hello-world", title: "Hello World", viewCount: 0 },
      ["slug"],
    );

    const found = await em.getRepository(testEntity.EntityClass).findOne({
      where: { slug: "hello-world" },
    });
    const item = Array.isArray(found) ? found[0] : found;

    expect(item).toBeDefined();
    expect(item.slug).toBe("hello-world");
    expect(item.title).toBe("Hello World");
    expect(item.viewCount).toBe(0);
  });

  // ─────────────────────────────────────────────────────────
  // UPDATE (충돌 키가 이미 존재하는 경우)
  // ─────────────────────────────────────────────────────────

  it("should update an existing record when conflict key exists", async () => {
    const repo = em.getRepository(testEntity.EntityClass);

    // 1. 먼저 레코드 삽입
    await em.upsert(
      testEntity.EntityClass,
      { slug: "my-post", title: "Original Title", viewCount: 10 },
      ["slug"],
    );

    // 2. 같은 slug으로 upsert → UPDATE 수행
    await em.upsert(
      testEntity.EntityClass,
      { slug: "my-post", title: "Updated Title", viewCount: 99 },
      ["slug"],
    );

    // 3. 검증: 레코드가 1개뿐이고, title과 viewCount가 업데이트되어야 함
    const all = await repo.find({ where: { slug: "my-post" } });
    const items = Array.isArray(all) ? all : all ? [all] : [];
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("Updated Title");
    expect(items[0].viewCount).toBe(99);
  });

  // ─────────────────────────────────────────────────────────
  // 특정 필드만 업데이트
  // ─────────────────────────────────────────────────────────

  it("should only update specified fields on conflict", async () => {
    const repo = em.getRepository(testEntity.EntityClass);

    // 1. 초기 삽입
    await em.upsert(
      testEntity.EntityClass,
      { slug: "partial-update", title: "Initial Title", viewCount: 5 },
      ["slug"],
    );

    // 2. title만 포함하여 upsert → title만 업데이트, viewCount는 그대로
    await em.upsert(
      testEntity.EntityClass,
      { slug: "partial-update", title: "Changed Title" },
      ["slug"],
    );

    // 3. 검증
    const found = await repo.findOne({ where: { slug: "partial-update" } });
    const item = Array.isArray(found) ? found[0] : found;

    expect(item).toBeDefined();
    expect(item.title).toBe("Changed Title");
    // viewCount는 ON DUPLICATE KEY UPDATE에서 VALUES(viewCount) 형태이므로
    // data에 viewCount가 없으면 업데이트 SET 절에 포함되지 않음
    expect(item.viewCount).toBe(5);
  });

  // ─────────────────────────────────────────────────────────
  // 여러 레코드 순차 upsert
  // ─────────────────────────────────────────────────────────

  it("should handle upsert of multiple records sequentially", async () => {
    const repo = em.getRepository(testEntity.EntityClass);

    // 1. 3개 레코드 순차 삽입
    await em.upsert(
      testEntity.EntityClass,
      { slug: "post-a", title: "Post A", viewCount: 1 },
      ["slug"],
    );
    await em.upsert(
      testEntity.EntityClass,
      { slug: "post-b", title: "Post B", viewCount: 2 },
      ["slug"],
    );
    await em.upsert(
      testEntity.EntityClass,
      { slug: "post-c", title: "Post C", viewCount: 3 },
      ["slug"],
    );

    // 2. 일부 업데이트
    await em.upsert(
      testEntity.EntityClass,
      { slug: "post-a", title: "Post A Updated", viewCount: 100 },
      ["slug"],
    );
    await em.upsert(
      testEntity.EntityClass,
      { slug: "post-c", title: "Post C Updated", viewCount: 300 },
      ["slug"],
    );

    // 3. 검증: 총 3개 레코드, 업데이트된 것만 변경
    const all = await repo.find();
    const items = Array.isArray(all) ? all : all ? [all] : [];
    expect(items.length).toBe(3);

    const sorted = items.sort((a: any, b: any) => a.slug.localeCompare(b.slug));

    expect(sorted[0].slug).toBe("post-a");
    expect(sorted[0].title).toBe("Post A Updated");
    expect(sorted[0].viewCount).toBe(100);

    expect(sorted[1].slug).toBe("post-b");
    expect(sorted[1].title).toBe("Post B");
    expect(sorted[1].viewCount).toBe(2);

    expect(sorted[2].slug).toBe("post-c");
    expect(sorted[2].title).toBe("Post C Updated");
    expect(sorted[2].viewCount).toBe(300);
  });
});
