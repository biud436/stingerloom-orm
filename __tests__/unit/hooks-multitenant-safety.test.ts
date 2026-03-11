/**
 * 멀티테넌시 환경에서 @BeforeInsert 등 생명주기 훅이
 * AsyncLocalStorage 컨텍스트를 올바르게 유지하는지 검증합니다.
 *
 * 검증 항목:
 * 1. 훅 내부에서 MetadataContext.getCurrentTenant()가 올바른 테넌트 반환
 * 2. 동시 실행 시 테넌트 간 컨텍스트 오염 없음
 * 3. EntitySubscriber에서도 테넌트 컨텍스트 유지
 * 4. EntityEventEmitter 리스너에서도 테넌트 컨텍스트 유지
 * 5. item 인스턴스가 테넌트 간 격리
 */
import "reflect-metadata";
import { MetadataContext } from "../../src/metadata/MetadataContext";

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "postgres",
        getType: jest.fn().mockReturnValue("postgres"),
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

let queryCallId = 0;
const mockQuery = jest.fn().mockImplementation(() => {
  const id = ++queryCallId;
  return Promise.resolve({
    results: [{ id, name: `user_${id}`, active: true }],
    fields: [],
  });
});
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { BeforeInsert, AfterInsert, BeforeUpdate } from "../../src/decorators/Hooks";
import { EntitySubscriber, InsertEvent } from "../../src/core/EntitySubscriber";

// ─── 테스트용 엔티티 ───

/** 훅 실행 시 MetadataContext를 기록하는 엔티티 */
@Entity()
class TenantUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "boolean" })
  active!: boolean;

  /** 훅이 실행될 때 캡처한 테넌트 ID를 저장 */
  capturedTenant?: string;
  capturedTenantAfter?: string;

  @BeforeInsert()
  captureBeforeInsert() {
    this.capturedTenant = MetadataContext.getCurrentTenant();
  }

  @AfterInsert()
  captureAfterInsert() {
    this.capturedTenantAfter = MetadataContext.getCurrentTenant();
  }
}

// ─── 공통 헬퍼 ───

function createTestEntityManager(): EntityManager {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `"${name}"`,
    castType: (t: string) => t,
  };
  (em as any).dbType = "postgres";

  const metadata = {
    name: "TenantUser",
    target: TenantUser,
    columns: [
      { name: "id", options: { primary: true, autoIncrement: true } },
      { name: "name", options: {} },
      { name: "active", options: {} },
    ],
  };
  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(metadata);
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);

  return em;
}

// ─── 테스트 ───

describe("생명주기 훅 — 멀티테넌시 AsyncLocalStorage 안전성", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    queryCallId = 0;
    MetadataContext.reset();
    em = createTestEntityManager();
  });

  // ───────────────────────────────────────────────────────────
  // 1. 단일 테넌트: 훅 내부에서 올바른 테넌트 ID 확인
  // ───────────────────────────────────────────────────────────

  it("@BeforeInsert 훅 내부에서 getCurrentTenant()가 올바른 테넌트 반환", async () => {
    const user = Object.assign(new TenantUser(), { name: "Alice", active: true });

    await em.withTenant("tenant_alpha", async (em) => {
      await em.save(TenantUser, user);
    });

    expect(user.capturedTenant).toBe("tenant_alpha");
  });

  it("@AfterInsert 훅 내부에서도 동일한 테넌트 컨텍스트 유지", async () => {
    const user = Object.assign(new TenantUser(), { name: "Bob", active: true });

    await em.withTenant("tenant_beta", async (em) => {
      await em.save(TenantUser, user);
    });

    expect(user.capturedTenantAfter).toBe("tenant_beta");
  });

  it("withTenant 없이 호출하면 public 컨텍스트", async () => {
    const user = Object.assign(new TenantUser(), { name: "Charlie", active: true });
    await em.save(TenantUser, user);

    expect(user.capturedTenant).toBe("public");
  });

  // ───────────────────────────────────────────────────────────
  // 2. 동시 실행: 두 테넌트가 동시에 save()해도 오염 없음
  // ───────────────────────────────────────────────────────────

  it("Promise.all로 두 테넌트가 동시에 save() — 각자 올바른 테넌트 ID", async () => {
    const userA = Object.assign(new TenantUser(), { name: "UserA", active: true });
    const userB = Object.assign(new TenantUser(), { name: "UserB", active: false });

    await Promise.all([
      em.withTenant("tenant_1", async (em) => {
        await em.save(TenantUser, userA);
      }),
      em.withTenant("tenant_2", async (em) => {
        await em.save(TenantUser, userB);
      }),
    ]);

    expect(userA.capturedTenant).toBe("tenant_1");
    expect(userB.capturedTenant).toBe("tenant_2");
    // 교차 오염 없음
    expect(userA.capturedTenant).not.toBe("tenant_2");
    expect(userB.capturedTenant).not.toBe("tenant_1");
  });

  it("10개 테넌트가 동시에 save() — 모두 올바른 테넌트 ID", async () => {
    const users: Array<{ tenantId: string; data: TenantUser }> = [];

    for (let i = 0; i < 10; i++) {
      users.push({
        tenantId: `tenant_${i}`,
        data: Object.assign(new TenantUser(), { name: `User_${i}`, active: i % 2 === 0 }),
      });
    }

    await Promise.all(
      users.map(({ tenantId, data }) =>
        em.withTenant(tenantId, async (em) => {
          await em.save(TenantUser, data);
        }),
      ),
    );

    for (const { tenantId, data } of users) {
      expect(data.capturedTenant).toBe(tenantId);
      expect(data.capturedTenantAfter).toBe(tenantId);
    }
  });

  // ───────────────────────────────────────────────────────────
  // 3. item 인스턴스 격리: 한 테넌트의 훅이 다른 테넌트 item 수정 불가
  // ───────────────────────────────────────────────────────────

  it("각 테넌트의 item 인스턴스가 독립적", async () => {
    const userA = Object.assign(new TenantUser(), { name: "Isolated_A", active: true });
    const userB = Object.assign(new TenantUser(), { name: "Isolated_B", active: false });

    await Promise.all([
      em.withTenant("iso_1", async (em) => {
        await em.save(TenantUser, userA);
      }),
      em.withTenant("iso_2", async (em) => {
        await em.save(TenantUser, userB);
      }),
    ]);

    // 각 item의 name이 변경되지 않았음 (다른 테넌트의 훅이 수정하지 않음)
    expect(userA.name).toBe("Isolated_A");
    expect(userB.name).toBe("Isolated_B");
    // 각 item에 캡처된 테넌트가 다름
    expect(userA.capturedTenant).not.toBe(userB.capturedTenant);
  });

  // ───────────────────────────────────────────────────────────
  // 4. EntitySubscriber에서도 테넌트 컨텍스트 유지
  // ───────────────────────────────────────────────────────────

  it("EntitySubscriber.beforeInsert 내부에서 올바른 테넌트 ID", async () => {
    const capturedTenants: string[] = [];

    class TenantUserSubscriber implements EntitySubscriber<TenantUser> {
      listenTo() {
        return TenantUser;
      }
      async beforeInsert(event: InsertEvent<TenantUser>) {
        capturedTenants.push(MetadataContext.getCurrentTenant());
      }
    }

    em.addSubscriber(new TenantUserSubscriber());

    await Promise.all([
      em.withTenant("sub_tenant_1", async (em) => {
        await em.save(TenantUser, Object.assign(new TenantUser(), { name: "Sub1", active: true }));
      }),
      em.withTenant("sub_tenant_2", async (em) => {
        await em.save(TenantUser, Object.assign(new TenantUser(), { name: "Sub2", active: true }));
      }),
    ]);

    expect(capturedTenants).toHaveLength(2);
    expect(capturedTenants).toContain("sub_tenant_1");
    expect(capturedTenants).toContain("sub_tenant_2");
  });

  // ───────────────────────────────────────────────────────────
  // 5. EntityEventEmitter 리스너에서도 테넌트 컨텍스트 유지
  // ───────────────────────────────────────────────────────────

  it("em.on('beforeInsert') 리스너 내부에서 올바른 테넌트 ID", async () => {
    const capturedTenants: string[] = [];

    em.on("beforeInsert", () => {
      capturedTenants.push(MetadataContext.getCurrentTenant());
    });

    await Promise.all([
      em.withTenant("evt_tenant_1", async (em) => {
        await em.save(TenantUser, Object.assign(new TenantUser(), { name: "Evt1", active: true }));
      }),
      em.withTenant("evt_tenant_2", async (em) => {
        await em.save(TenantUser, Object.assign(new TenantUser(), { name: "Evt2", active: true }));
      }),
    ]);

    expect(capturedTenants).toHaveLength(2);
    expect(capturedTenants).toContain("evt_tenant_1");
    expect(capturedTenants).toContain("evt_tenant_2");
  });

  // ───────────────────────────────────────────────────────────
  // 6. 지연(sleep) 포함 동시성: 비동기 대기 중에도 컨텍스트 유지
  // ───────────────────────────────────────────────────────────

  it("훅 내부에서 비동기 대기 후에도 테넌트 컨텍스트 유지", async () => {
    const tenantsDuringDelay: string[] = [];

    // 지연이 있는 BeforeInsert를 시뮬레이션하기 위해 runHooks를 래핑
    const originalRunHooks = (em as any).cascadeHandler.runHooks.bind((em as any).cascadeHandler);
    jest.spyOn((em as any).cascadeHandler, "runHooks").mockImplementation(
      async (entity: any, item: any, event: any) => {
        // 원래 훅 실행
        await originalRunHooks(entity, item, event);
        if (event === "beforeInsert") {
          // 비동기 지연 후에도 컨텍스트가 유지되는지 확인
          await new Promise((resolve) => setTimeout(resolve, 10));
          tenantsDuringDelay.push(MetadataContext.getCurrentTenant());
        }
      },
    );

    await Promise.all([
      em.withTenant("delay_1", async (em) => {
        await em.save(TenantUser, Object.assign(new TenantUser(), { name: "Delay1", active: true }));
      }),
      em.withTenant("delay_2", async (em) => {
        await em.save(TenantUser, Object.assign(new TenantUser(), { name: "Delay2", active: true }));
      }),
    ]);

    expect(tenantsDuringDelay).toHaveLength(2);
    expect(tenantsDuringDelay).toContain("delay_1");
    expect(tenantsDuringDelay).toContain("delay_2");
  });

  // ───────────────────────────────────────────────────────────
  // 7. 중첩 withTenant: 내부 테넌트가 외부를 오염시키지 않음
  // ───────────────────────────────────────────────────────────

  it("중첩 withTenant에서 내부 컨텍스트가 외부를 덮어쓰지 않음", async () => {
    const outerUser = Object.assign(new TenantUser(), { name: "Outer", active: true });
    const innerUser = Object.assign(new TenantUser(), { name: "Inner", active: false });

    await em.withTenant("outer_tenant", async (em) => {
      await em.save(TenantUser, outerUser);

      // 내부에서 다른 테넌트로 전환
      await em.withTenant("inner_tenant", async (em) => {
        await em.save(TenantUser, innerUser);
      });

      // 내부 withTenant가 끝난 후 외부 컨텍스트가 복원되는지 확인
      const afterInner = MetadataContext.getCurrentTenant();
      expect(afterInner).toBe("outer_tenant");
    });

    expect(outerUser.capturedTenant).toBe("outer_tenant");
    expect(innerUser.capturedTenant).toBe("inner_tenant");
  });
});
