/**
 * Verifies that lifecycle hooks such as @BeforeInsert preserve the
 * AsyncLocalStorage context in a multi-tenant environment.
 *
 * Assertions:
 * 1. Hooks see the correct tenant via MetadataContext.getCurrentTenant()
 * 2. Concurrent runs do not leak context between tenants
 * 3. EntitySubscriber also sees the correct tenant context
 * 4. EntityEventEmitter listeners also see the correct tenant context
 * 5. Item instances stay isolated per tenant
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

// ─── Test entities ───

/** Entity that records MetadataContext when its hooks run */
@Entity()
class TenantUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "boolean" })
  active!: boolean;

  /** Stores the tenant ID captured when hooks run */
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

// ─── Common helpers ───

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

// ─── Tests ───

describe("생명주기 훅 — 멀티테넌시 AsyncLocalStorage 안전성", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    queryCallId = 0;
    MetadataContext.reset();
    em = createTestEntityManager();
  });

  // ───────────────────────────────────────────────────────────
  // 1. Single tenant: verify the hook sees the correct tenant ID
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
  // 2. Concurrency: two tenants calling save() concurrently stay isolated
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
    // No cross-contamination
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
  // 3. Item instance isolation: a tenant's hook must not touch another tenant's item
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

    // Each item's name is unchanged (another tenant's hook did not touch it)
    expect(userA.name).toBe("Isolated_A");
    expect(userB.name).toBe("Isolated_B");
    // Each item captures a different tenant
    expect(userA.capturedTenant).not.toBe(userB.capturedTenant);
  });

  // ───────────────────────────────────────────────────────────
  // 4. EntitySubscriber preserves the tenant context
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
  // 5. EntityEventEmitter listeners preserve the tenant context
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
  // 6. Concurrency with sleeps: context persists across async waits
  // ───────────────────────────────────────────────────────────

  it("훅 내부에서 비동기 대기 후에도 테넌트 컨텍스트 유지", async () => {
    const tenantsDuringDelay: string[] = [];

    // Wrap runHooks to simulate a BeforeInsert with an async delay
    const originalRunHooks = (em as any).cascadeHandler.runHooks.bind((em as any).cascadeHandler);
    jest.spyOn((em as any).cascadeHandler, "runHooks").mockImplementation(
      async (entity: any, item: any, event: any) => {
        // Run the original hooks
        await originalRunHooks(entity, item, event);
        if (event === "beforeInsert") {
          // Verify the context persists even after an async delay
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
  // 7. Nested withTenant: inner context does not leak to the outer scope
  // ───────────────────────────────────────────────────────────

  it("중첩 withTenant에서 내부 컨텍스트가 외부를 덮어쓰지 않음", async () => {
    const outerUser = Object.assign(new TenantUser(), { name: "Outer", active: true });
    const innerUser = Object.assign(new TenantUser(), { name: "Inner", active: false });

    await em.withTenant("outer_tenant", async (em) => {
      await em.save(TenantUser, outerUser);

      // Switch to a different tenant inside
      await em.withTenant("inner_tenant", async (em) => {
        await em.save(TenantUser, innerUser);
      });

      // Verify the outer context is restored after the inner withTenant exits
      const afterInner = MetadataContext.getCurrentTenant();
      expect(afterInner).toBe("outer_tenant");
    });

    expect(outerUser.capturedTenant).toBe("outer_tenant");
    expect(innerUser.capturedTenant).toBe("inner_tenant");
  });
});
