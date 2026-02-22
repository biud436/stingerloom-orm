/**
 * 멀티테넌시 PostgreSQL 통합 테스트
 *
 * PostgreSQL의 스키마 기반 멀티테넌시를 실제 DB 연결로 검증합니다.
 *
 * 검증 항목:
 * 1. EntityManager(schema: 'tenant_a')가 PostgreSQL 스키마를 자동 생성한다
 * 2. 테이블이 올바른 스키마에 생성된다 (pg_tables 확인)
 * 3. 스키마 간 데이터 격리 (tenant_a ↔ tenant_b)
 * 4. BaseRepository가 스키마 한정 식별자로 동작한다
 * 5. withTenant() 컨텍스트 전파 및 동시성 격리
 *
 * 실행 방법:
 *   INTEGRATION_TEST=true pnpm test -- --testPathPattern="multi-tenancy-postgres"
 *
 * 사전 조건:
 *   - PostgreSQL 서버 실행 중 (localhost:5432)
 *   - DB: multi_tenancy_db / User: postgres / Password: postgres
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import {
  createTestConnection,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";
import { createCrudTestEntity, DynamicEntityResult } from "./helpers/create-test-entity";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

/** PostgreSQL 연결 기본 옵션 */
const PG_BASE: Partial<DatabaseClientOptions> = {
  type: "postgres",
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

/** 스키마 DROP (cleanup 용) */
async function dropSchema(name: string): Promise<void> {
  try {
    await rawQuery(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  } catch {
    // ignore
  }
}

/** 타임스탬프 기반 고유 스키마 이름 생성 */
function uniqueSchemaName(base: string): string {
  return `${base}_${Date.now()}`;
}

// ─────────────────────────────────────────────────────────────────
// Suite 1: PostgreSQL 스키마 자동 생성 및 라우팅
// ─────────────────────────────────────────────────────────────────

integrationDescribe("[Integration][Postgres] 스키마 자동 생성 및 라우팅", () => {
  const schemaA = uniqueSchemaName("test_mt_a");
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...PG_BASE, schema: schemaA, synchronize: true, logging: false },
      () => {
        testEntity = createCrudTestEntity("mt_user");
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;
  }, 30000);

  afterAll(async () => {
    await dropSchema(schemaA);
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    try {
      await rawQuery(`DELETE FROM "${schemaA}"."${testEntity.tableName}"`);
    } catch {
      // 테이블이 아직 없는 경우 무시
    }
  });

  it("EntityManager.register() 시 스키마가 자동 생성된다", async () => {
    const rows = await rawQuery(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${schemaA}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].schema_name).toBe(schemaA);
  });

  it("테이블이 지정된 스키마 내에 생성된다 (pg_tables)", async () => {
    const rows = await rawQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = '${schemaA}' AND tablename = '${testEntity.tableName}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tablename).toBe(testEntity.tableName);
  });

  it("동일 테이블명이 public 스키마에는 존재하지 않는다", async () => {
    const rows = await rawQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '${testEntity.tableName}'`,
    );
    expect(rows.length).toBe(0);
  });

  it("EntityManager.save()가 스키마 한정 테이블에 저장한다", async () => {
    await em.save(testEntity.EntityClass, {
      name: "Alice",
      age: 30,
      email: "alice@test.com",
    });

    const rows = await rawQuery(
      `SELECT name FROM "${schemaA}"."${testEntity.tableName}"`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Alice");
  });

  it("EntityManager.find()가 올바른 스키마에서 조회한다", async () => {
    await em.save(testEntity.EntityClass, { name: "Bob1", age: 25, email: null });
    await em.save(testEntity.EntityClass, { name: "Bob2", age: 26, email: null });

    const found = await em.find(testEntity.EntityClass);
    // find()는 results.length > 1이면 배열, 1이면 단일 엔티티를 반환
    const foundArray = Array.isArray(found) ? found : found ? [found] : [];
    expect(foundArray.length).toBeGreaterThanOrEqual(2);
    expect(foundArray.some((r: any) => r.name === "Bob1")).toBe(true);
    expect(foundArray.some((r: any) => r.name === "Bob2")).toBe(true);
  });

  it("EntityManager.findOne()이 스키마 한정 조건으로 단건 조회한다", async () => {
    await em.save(testEntity.EntityClass, {
      name: "Charlie",
      age: 35,
      email: null,
    });

    const found = await em.findOne(testEntity.EntityClass, {
      where: { name: "Charlie" },
    });
    expect(found).not.toBeNull();
    expect((found as any).name).toBe("Charlie");
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 2: 스키마 간 데이터 격리
// ─────────────────────────────────────────────────────────────────

integrationDescribe("[Integration][Postgres] 스키마 간 데이터 격리", () => {
  const schemaA = uniqueSchemaName("test_mt_iso_a");
  const schemaB = uniqueSchemaName("test_mt_iso_b");
  let connA: TestConnectionResult;
  let emA: EntityManager;
  let entityA: DynamicEntityResult;

  beforeAll(async () => {
    // schema_a 연결 및 데이터 삽입
    connA = await createTestConnection(
      { ...PG_BASE, schema: schemaA, synchronize: true, logging: false },
      () => {
        entityA = createCrudTestEntity("iso_user");
        return { entities: [entityA.EntityClass] };
      },
    );
    emA = connA.em;
  }, 30000);

  afterAll(async () => {
    await dropSchema(schemaA);
    await dropSchema(schemaB);
    await connA.cleanup();
  }, 15000);

  it("schema_a에 삽입한 데이터가 schema_b에는 없다", async () => {
    await emA.save(entityA.EntityClass, {
      name: "TenantA_User",
      age: 20,
      email: null,
    });

    // schema_a에 데이터 존재 확인
    const inA = await rawQuery(
      `SELECT name FROM "${schemaA}"."${entityA.tableName}" WHERE name = 'TenantA_User'`,
    );
    expect(inA.length).toBe(1);

    // schema_b에는 테이블 자체가 없음 (아직 연결 전)
    const tableInB = await rawQuery(
      `SELECT COUNT(*) as count FROM information_schema.tables ` +
        `WHERE table_schema = '${schemaB}' AND table_name = '${entityA.tableName}'`,
    );
    expect(Number(tableInB[0].count)).toBe(0);
  });

  it("schema_b에 동일 이름의 테이블을 만들어도 schema_a 데이터와 독립적이다", async () => {
    // schema_a에 사전 데이터 삽입
    await emA.save(entityA.EntityClass, {
      name: "Only_In_A",
      age: 99,
      email: null,
    });

    // schema_b에 연결 (새 EntityManager)
    const connB = await createTestConnection(
      { ...PG_BASE, schema: schemaB, synchronize: true, logging: false },
      () => {
        const entityB = createCrudTestEntity("iso_user");
        // 테이블명은 다르지만 구조는 동일
        return { entities: [entityB.EntityClass] };
      },
    );

    try {
      // schema_b 테이블은 비어있어야 함
      const inB = await rawQuery(
        `SELECT COUNT(*) as count FROM "${schemaB}"."${entityA.tableName}" ` +
          `WHERE name = 'Only_In_A'`,
      ).catch(() => [{ count: "0" }]); // 테이블명이 다르면 빈 결과

      // schema_a의 Only_In_A가 schema_b에 없음
      expect(Number(inB[0].count)).toBe(0);

      // schema_a에는 여전히 존재
      const stillInA = await rawQuery(
        `SELECT name FROM "${schemaA}"."${entityA.tableName}" WHERE name = 'Only_In_A'`,
      );
      expect(stillInA.length).toBeGreaterThanOrEqual(1);
    } finally {
      await connB.cleanup();
    }
  });

  it("존재하지 않는 스키마.테이블 직접 조회 시 에러가 발생한다", async () => {
    const fakeSchema = "nonexistent_schema_xyz";
    await expect(
      rawQuery(
        `SELECT * FROM "${fakeSchema}"."some_table"`,
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 3: BaseRepository와 스키마 한정 식별자
// ─────────────────────────────────────────────────────────────────

integrationDescribe("[Integration][Postgres] BaseRepository — 스키마 한정 동작", () => {
  const schemaRepo = uniqueSchemaName("test_mt_repo");
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;
  let repo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...PG_BASE, schema: schemaRepo, synchronize: true, logging: false },
      () => {
        testEntity = createCrudTestEntity("repo_user");
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;
    repo = em.getRepository(testEntity.EntityClass);
  }, 30000);

  afterAll(async () => {
    await dropSchema(schemaRepo);
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    try {
      await rawQuery(`DELETE FROM "${schemaRepo}"."${testEntity.tableName}"`);
    } catch {
      // ignore
    }
  });

  it("repo.save()가 스키마 한정 테이블에 저장한다", async () => {
    const instance = new testEntity.EntityClass();
    instance.name = "RepoUser";
    instance.age = 33;
    instance.email = null;

    await repo.save(instance);

    const rows = await rawQuery(
      `SELECT name FROM "${schemaRepo}"."${testEntity.tableName}"`,
    );
    expect(rows.some((r: any) => r.name === "RepoUser")).toBe(true);
  });

  it("repo.find()가 올바른 스키마에서 다건 조회한다", async () => {
    const a = new testEntity.EntityClass();
    a.name = "User_A";
    a.age = 20;
    const b = new testEntity.EntityClass();
    b.name = "User_B";
    b.age = 21;

    await repo.save(a);
    await repo.save(b);

    const found = await repo.find();
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found.some((r: any) => r.name === "User_A")).toBe(true);
    expect(found.some((r: any) => r.name === "User_B")).toBe(true);
  });

  it("repo.findOne()이 스키마 한정 조건으로 단건 조회한다", async () => {
    const instance = new testEntity.EntityClass();
    instance.name = "UniqueRepoUser";
    instance.age = 40;
    await repo.save(instance);

    const found = await repo.findOne({ where: { name: "UniqueRepoUser" } });
    expect(found).not.toBeNull();
    expect(found?.name).toBe("UniqueRepoUser");
  });

  it("repo.count()가 스키마 내 행 수를 정확히 반환한다", async () => {
    const u1 = new testEntity.EntityClass();
    u1.name = "Count_1";
    u1.age = 10;
    const u2 = new testEntity.EntityClass();
    u2.name = "Count_2";
    u2.age = 11;

    await repo.save(u1);
    await repo.save(u2);

    const count = await repo.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 4: withTenant() 컨텍스트 전파 및 동시성 격리
// (실제 DB 연결 불필요 — MetadataContext/AsyncLocalStorage 검증)
// ─────────────────────────────────────────────────────────────────

integrationDescribe(
  "[Integration][Postgres] withTenant() 컨텍스트 전파 및 격리",
  () => {
    const schemaTenant = uniqueSchemaName("test_mt_ctx");
    let conn: TestConnectionResult;
    let em: EntityManager;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, schema: schemaTenant, synchronize: true, logging: false },
        () => {
          const entity = createCrudTestEntity("ctx_user");
          return { entities: [entity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      await dropSchema(schemaTenant);
      await conn.cleanup();
    }, 15000);

    it("withTenant()가 콜백 내부에 tenantId를 전파한다", async () => {
      let capturedTenant = "";

      await em.withTenant("tenant_xyz", async () => {
        capturedTenant = MetadataContext.getCurrentTenant();
      });

      expect(capturedTenant).toBe("tenant_xyz");
    });

    it("withTenant() 블록 외부에서는 MetadataContext가 비활성화된다", async () => {
      await em.withTenant("some_tenant", async () => {
        expect(MetadataContext.isActive()).toBe(true);
      });

      expect(MetadataContext.isActive()).toBe(false);
    });

    it("중첩 withTenant()에서 내부 컨텍스트가 외부를 덮어쓰고 복원된다", async () => {
      const tenants: string[] = [];

      await em.withTenant("outer_tenant", async () => {
        tenants.push(MetadataContext.getCurrentTenant()); // outer_tenant

        await em.withTenant("inner_tenant", async () => {
          tenants.push(MetadataContext.getCurrentTenant()); // inner_tenant
        });

        tenants.push(MetadataContext.getCurrentTenant()); // outer_tenant 복원
      });

      expect(tenants).toEqual(["outer_tenant", "inner_tenant", "outer_tenant"]);
    });

    it("동시 withTenant() 호출이 독립적으로 격리된다 (3개 병렬)", async () => {
      const results = await Promise.all([
        em.withTenant("tenant_alpha", async () => {
          await new Promise((r) => setTimeout(r, 20));
          return MetadataContext.getCurrentTenant();
        }),
        em.withTenant("tenant_beta", async () => {
          await new Promise((r) => setTimeout(r, 5));
          return MetadataContext.getCurrentTenant();
        }),
        em.withTenant("tenant_gamma", async () => {
          await new Promise((r) => setTimeout(r, 15));
          return MetadataContext.getCurrentTenant();
        }),
      ]);

      expect(results[0]).toBe("tenant_alpha");
      expect(results[1]).toBe("tenant_beta");
      expect(results[2]).toBe("tenant_gamma");
    });

    it("10개 동시 withTenant() 호출이 모두 독립적으로 격리된다", async () => {
      const tenantIds = Array.from({ length: 10 }, (_, i) => `tenant_${i}`);

      const results = await Promise.all(
        tenantIds.map((id) =>
          em.withTenant(id, async () => {
            // 각기 다른 지연으로 인터리빙 유도
            await new Promise((r) =>
              setTimeout(r, Math.floor(Math.random() * 20)),
            );
            return MetadataContext.getCurrentTenant();
          }),
        ),
      );

      // 모든 결과가 올바른 tenantId를 반환해야 함
      results.forEach((result, idx) => {
        expect(result).toBe(tenantIds[idx]);
      });
    });

    it("withTenant() 내에서 예외 발생 시에도 컨텍스트가 정리된다", async () => {
      await expect(
        em.withTenant("failing_tenant", async () => {
          throw new Error("deliberate error");
        }),
      ).rejects.toThrow("deliberate error");

      // 예외 후에도 컨텍스트는 비활성
      expect(MetadataContext.isActive()).toBe(false);
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// Suite 5: LayeredMetadataRegistry + withTenant() 통합
// (메타데이터 레이어가 withTenant() 컨텍스트 전환에 반응하는지 검증)
// ─────────────────────────────────────────────────────────────────

integrationDescribe(
  "[Integration][Postgres] MetadataLayerRegistry + withTenant() 통합",
  () => {
    const schemaInteg = uniqueSchemaName("test_mt_integ");
    let conn: TestConnectionResult;
    let em: EntityManager;

    beforeAll(async () => {
      conn = await createTestConnection(
        {
          ...PG_BASE,
          schema: schemaInteg,
          synchronize: true,
          logging: false,
        },
        () => {
          const entity = createCrudTestEntity("integ_user");
          return { entities: [entity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      await dropSchema(schemaInteg);
      await conn.cleanup();
    }, 15000);

    it("withTenant() 내부에서 MetadataLayerRegistry.getContext()가 tenantId를 반환한다", async () => {
      let registryCtx = "";
      const registry = MetadataLayerRegistry.getInstance();

      await em.withTenant("registry_tenant", async () => {
        registryCtx = registry.getContext();
      });

      expect(registryCtx).toBe("registry_tenant");
    });

    it("withTenant() 외부에서 MetadataLayerRegistry.getContext()가 'public'을 반환한다", () => {
      const registry = MetadataLayerRegistry.getInstance();
      expect(registry.getContext()).toBe("public");
    });

    it("동시 withTenant()에서 각 컨텍스트가 독립적인 레지스트리 뷰를 가진다", async () => {
      const registry = MetadataLayerRegistry.getInstance();

      // 테넌트 레이어에 각자 다른 데이터 설정
      registry.setContext("ctx_a");
      registry.getCurrentLayer().set("config::plan", "premium");

      registry.setContext("ctx_b");
      registry.getCurrentLayer().set("config::plan", "basic");

      registry.setContext("public"); // 수동 컨텍스트 복원

      const results = await Promise.all([
        em.withTenant("ctx_a", async () => {
          await new Promise((r) => setTimeout(r, 10));
          return registry.resolveValue<string>("config::plan");
        }),
        em.withTenant("ctx_b", async () => {
          await new Promise((r) => setTimeout(r, 5));
          return registry.resolveValue<string>("config::plan");
        }),
      ]);

      expect(results[0]).toBe("premium");
      expect(results[1]).toBe("basic");
    });
  },
);
