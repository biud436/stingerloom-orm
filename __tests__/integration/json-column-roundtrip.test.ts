/**
 * JSON 컬럼 auto-transformer 통합 테스트 — save() → findOne() 라운드트립
 *
 * `@Column({ type: "json" | "jsonb" })` 가 caller-side `JSON.stringify` 없이
 * 평범한 JS 객체/배열을 그대로 직렬화하고, 읽을 때 다시 파싱해 돌려주는지
 * 실제 DB 에 대해 검증한다. Issue #338 의 acceptance criteria — 서비스 코드는
 * plain object 만 넘긴다 — 를 라운드트립으로 못박는다.
 *
 * 같은 시나리오를 MySQL(`json`) 과 PostgreSQL(`jsonb`) 양쪽에서 실행한다.
 * MySQL/SQLite 드라이버는 JSON 컬럼을 문자열로 surface 하고 pg jsonb 는 이미
 * 파싱된 값을 돌려주지만, ORM 레벨 transformer 가 두 경로를 동일하게 정규화한다.
 *
 * 요구사항:
 *   INTEGRATION_TEST=true (jest config gate)
 *   접근 가능한 MySQL / PostgreSQL
 *     개별 비활성화: INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createDynamicEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;
const describeIf = skipReason ? describe.skip : describe;

describeIf.each(getTestDrivers())(
  "[Integration] JSON 컬럼 auto-transformer 라운드트립 ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;

    // PostgreSQL 은 jsonb(네이티브 파싱), MySQL 은 json.
    const jsonType = type === "postgres" ? "jsonb" : "json";

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          testEntity = createDynamicEntity("json_roundtrip", [
            { name: "id", designType: Number, primary: true },
            {
              name: "name",
              designType: String,
              options: { type: "varchar", length: 255 },
            },
            {
              // 실제 엔티티의 `customFields: Record<string, unknown>` 와 동일하게
              // design:type 은 Object, 컬럼 타입은 명시적으로 json/jsonb.
              name: "customFields",
              designType: Object,
              options: { type: jsonType, nullable: true },
            },
          ]);
          return { entities: [testEntity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      try {
        if (testEntity) await dropTestTable(testEntity.tableName);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await truncateTestTable(testEntity.tableName);
    });

    it("plain object 를 save 하면 caller 의 JSON.stringify 없이 라운드트립된다", async () => {
      // Issue #338 본문이 명시한 예시 페이로드.
      const customFields = { severity: "S0", labels: ["a", "b"] };

      const saved = await em.save(testEntity.EntityClass, {
        name: "issue-1",
        customFields,
      });

      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });

      expect(found).not.toBeNull();
      // 읽기 시 객체로 복원되어야 한다 — 문자열이 아님.
      expect(typeof found!.customFields).toBe("object");
      expect(found!.customFields).toEqual(customFields);
    });

    it("최상위 배열 값도 라운드트립된다", async () => {
      const customFields = ["red", "green", { nested: true }];

      const saved = await em.save(testEntity.EntityClass, {
        name: "array-fields",
        customFields,
      });
      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });

      expect(Array.isArray(found!.customFields)).toBe(true);
      expect(found!.customFields).toEqual(customFields);
    });

    it("깊게 중첩된 객체/배열 구조를 그대로 보존한다", async () => {
      const customFields = {
        meta: { tags: ["x", "y"], counts: { open: 3, closed: 7 } },
        items: [
          { id: 1, ok: true },
          { id: 2, ok: false },
        ],
      };

      const saved = await em.save(testEntity.EntityClass, {
        name: "nested-fields",
        customFields,
      });
      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });

      expect(found!.customFields).toEqual(customFields);
    });

    it("nullable JSON 컬럼에 null 을 저장하면 null 로 돌아온다", async () => {
      const saved = await em.save(testEntity.EntityClass, {
        name: "null-fields",
        customFields: null,
      });
      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });

      expect(found).not.toBeNull();
      expect(found!.customFields == null).toBe(true);
    });

    it("이미 직렬화된 문자열은 이중 인코딩하지 않는다 (idempotency)", async () => {
      // 마이그레이션 전 레거시 코드가 수동으로 JSON.stringify 한 값.
      const payload = { severity: "S1", labels: ["legacy"] };
      const preSerialized = JSON.stringify(payload);

      const saved = await em.save(testEntity.EntityClass, {
        name: "pre-serialized",
        customFields: preSerialized as unknown as Record<string, unknown>,
      });
      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });

      // 이중 인코딩됐다면 읽을 때 객체가 아닌 문자열이 나왔을 것이다.
      // 한 번만 인코딩 → 객체로 정상 복원.
      expect(found!.customFields).toEqual(payload);
    });
  },
);
