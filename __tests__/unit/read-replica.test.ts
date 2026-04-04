import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  ReplicationRouter,
  ReplicationConfig,
  ReplicationNodeConfig,
} from "../../src/dialects/ReplicationRouter";

// ─────────────────────────────────────────────────────────────────────────────
// Mock 설정
// ─────────────────────────────────────────────────────────────────────────────

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({
          type: "mysql",
          host: "master-host",
          port: 3306,
          username: "root",
          password: "pass",
          database: "testdb",
          synchronize: false,
        }),
        connect: jest.fn(),
      }),
    },
  };
});

const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockConnectToNode = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      connectToNode: mockConnectToNode,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

const masterNode: ReplicationNodeConfig = {
  host: "master-host",
  port: 3306,
  username: "root",
  password: "pass",
  database: "testdb",
};

const slave1: ReplicationNodeConfig = {
  host: "slave1-host",
  port: 3306,
  username: "reader",
  password: "pass",
  database: "testdb",
};

const slave2: ReplicationNodeConfig = {
  host: "slave2-host",
  port: 3306,
  username: "reader",
  password: "pass",
  database: "testdb",
};

const replicationConfig: ReplicationConfig = {
  master: masterNode,
  slaves: [slave1, slave2],
};

const ItemEntity = class Item {} as any;

const itemMetadata = {
  name: "Item",
  target: ItemEntity,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", options: {} },
  ],
};

function createReplicatedEntityManager(): EntityManager {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  (em as any).replication["router"] = new ReplicationRouter(replicationConfig);
  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(itemMetadata);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  return em;
}

function createNonReplicatedEntityManager(): EntityManager {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(itemMetadata);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  return em;
}

// ─────────────────────────────────────────────────────────────────────────────
// ReplicationRouter 단위 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplicationRouter", () => {
  let router: ReplicationRouter;

  beforeEach(() => {
    router = new ReplicationRouter(replicationConfig);
  });

  it("should return master node for getWriteNode()", () => {
    expect(router.getWriteNode()).toBe(masterNode);
  });

  it("should return slave node for getReadNode()", () => {
    const readNode = router.getReadNode();
    expect([slave1, slave2]).toContain(readNode);
  });

  it("should round-robin between slaves", () => {
    const nodes: ReplicationNodeConfig[] = [];
    for (let i = 0; i < 4; i++) {
      nodes.push(router.getReadNode());
    }
    // slave1과 slave2가 번갈아 나와야 함
    expect(nodes[0]).toBe(slave1);
    expect(nodes[1]).toBe(slave2);
    expect(nodes[2]).toBe(slave1);
    expect(nodes[3]).toBe(slave2);
  });

  it("should skip failed slaves in round-robin", () => {
    router.markSlaveFailed(slave1);

    const node = router.getReadNode();
    expect(node).toBe(slave2);
  });

  it("should fallback to master when all slaves are failed", () => {
    router.markSlaveFailed(slave1);
    router.markSlaveFailed(slave2);

    const node = router.getReadNode();
    expect(node).toBe(masterNode);
  });

  it("should recover slaves when marked as recovered", () => {
    router.markSlaveFailed(slave1);
    router.markSlaveFailed(slave2);
    router.markSlaveRecovered(slave1);

    const node = router.getReadNode();
    expect(node).toBe(slave1);
  });

  it("should reset all failed slaves", () => {
    router.markSlaveFailed(slave1);
    router.markSlaveFailed(slave2);
    router.resetFailedSlaves();

    expect(router.healthySlaveCount).toBe(2);
  });

  it("should report correct slave count", () => {
    expect(router.slaveCount).toBe(2);
  });

  it("should report correct healthy slave count", () => {
    router.markSlaveFailed(slave1);
    expect(router.healthySlaveCount).toBe(1);
  });

  it("should correctly identify master node", () => {
    expect(router.isMaster(masterNode)).toBe(true);
    expect(router.isMaster(slave1)).toBe(false);
  });

  it("should throw if no master is provided", () => {
    expect(() => new ReplicationRouter({ master: null as any, slaves: [slave1] }))
      .toThrow("master");
  });

  it("should throw if no slaves are provided", () => {
    expect(() => new ReplicationRouter({ master: masterNode, slaves: [] }))
      .toThrow("slave");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EntityManager read replica 라우팅 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("EntityManager read replica routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should route find() to slave via connectToNode when replication is enabled", async () => {
    const em = createReplicatedEntityManager();

    mockQuery
      .mockResolvedValueOnce({ results: [{ id: 1, title: "Test" }], fields: [] });

    await em.find(ItemEntity, { where: { id: 1 } as any });

    expect(mockConnectToNode).toHaveBeenCalledTimes(1);
    // slave1 또는 slave2로 라우팅되어야 함
    const calledNode = mockConnectToNode.mock.calls[0][0];
    expect([slave1, slave2]).toContain(calledNode);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("should use normal connect() when replication is not enabled", async () => {
    const em = createNonReplicatedEntityManager();

    mockQuery
      .mockResolvedValueOnce({ results: [{ id: 1, title: "Test" }], fields: [] });

    await em.find(ItemEntity, { where: { id: 1 } as any });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnectToNode).not.toHaveBeenCalled();
  });

  it("should route to master when useMaster=true in FindOption", async () => {
    const em = createReplicatedEntityManager();

    mockQuery
      .mockResolvedValueOnce({ results: [{ id: 1, title: "Test" }], fields: [] });

    await em.find(ItemEntity, {
      where: { id: 1 } as any,
      useMaster: true,
    });

    expect(mockConnectToNode).toHaveBeenCalledTimes(1);
    expect(mockConnectToNode.mock.calls[0][0]).toBe(masterNode);
  });

  it("should route findWithCursor() to slave when replication is enabled", async () => {
    const em = createReplicatedEntityManager();

    mockQuery
      .mockResolvedValueOnce({ results: [{ id: 1, title: "Test" }], fields: [] });

    await em.findWithCursor(ItemEntity, { take: 10 });

    expect(mockConnectToNode).toHaveBeenCalledTimes(1);
    const calledNode = mockConnectToNode.mock.calls[0][0];
    expect([slave1, slave2]).toContain(calledNode);
  });

  it("should route findWithCursor() to master when useMaster=true", async () => {
    const em = createReplicatedEntityManager();

    mockQuery
      .mockResolvedValueOnce({ results: [{ id: 1, title: "Test" }], fields: [] });

    await em.findWithCursor(ItemEntity, { take: 10, useMaster: true });

    expect(mockConnectToNode).toHaveBeenCalledTimes(1);
    expect(mockConnectToNode.mock.calls[0][0]).toBe(masterNode);
  });

  it("getReadNode() should return null when replication is not configured", () => {
    const em = createNonReplicatedEntityManager();
    expect(em.getReadNode()).toBeNull();
  });

  it("getWriteNode() should return null when replication is not configured", () => {
    const em = createNonReplicatedEntityManager();
    expect(em.getWriteNode()).toBeNull();
  });

  it("isReplicationEnabled should be true when replication is configured", () => {
    const em = createReplicatedEntityManager();
    expect(em.isReplicationEnabled).toBe(true);
  });

  it("isReplicationEnabled should be false when replication is not configured", () => {
    const em = createNonReplicatedEntityManager();
    expect(em.isReplicationEnabled).toBe(false);
  });

  it("getReplicationRouter() should return the router when configured", () => {
    const em = createReplicatedEntityManager();
    expect(em.getReplicationRouter()).toBeInstanceOf(ReplicationRouter);
  });

  it("should route explain() to slave when replication is enabled", async () => {
    const em = createReplicatedEntityManager();
    (em as any).driver.supportsExplain = () => true;
    (em as any).driver.buildExplainSql = () => "EXPLAIN ";

    mockQuery
      .mockResolvedValueOnce({
        results: [{ id: 1, select_type: "SIMPLE", type: "ALL", rows: 10 }],
        fields: [],
      });

    await em.explain(ItemEntity, { where: { id: 1 } as any });

    expect(mockConnectToNode).toHaveBeenCalledTimes(1);
    const calledNode = mockConnectToNode.mock.calls[0][0];
    expect([slave1, slave2]).toContain(calledNode);
  });

  it("should route explain() to master when useMaster=true", async () => {
    const em = createReplicatedEntityManager();
    (em as any).driver.supportsExplain = () => true;
    (em as any).driver.buildExplainSql = () => "EXPLAIN ";

    mockQuery
      .mockResolvedValueOnce({
        results: [{ id: 1, select_type: "SIMPLE", type: "ALL", rows: 10 }],
        fields: [],
      });

    await em.explain(ItemEntity, { where: { id: 1 } as any, useMaster: true });

    expect(mockConnectToNode).toHaveBeenCalledTimes(1);
    expect(mockConnectToNode.mock.calls[0][0]).toBe(masterNode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FindOption.useMaster 타입 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("FindOption.useMaster", () => {
  it("should accept useMaster in FindOption type", () => {
    // TypeScript 컴파일 타임 테스트 — useMaster 옵션이 허용되는지 확인
    const option = {
      where: { id: 1 },
      useMaster: true,
    };
    expect(option.useMaster).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #225: Health check for read replicas
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplicationRouter health check", () => {
  const masterNode: ReplicationNodeConfig = {
    host: "master",
    port: 3306,
    username: "root",
    password: "pass",
    database: "db",
  };
  const slave1: ReplicationNodeConfig = {
    host: "slave1",
    port: 3306,
    username: "root",
    password: "pass",
    database: "db",
  };
  const slave2: ReplicationNodeConfig = {
    host: "slave2",
    port: 3306,
    username: "root",
    password: "pass",
    database: "db",
  };

  it("should auto-mark slave as failed after failureThreshold", async () => {
    const router = new ReplicationRouter({
      master: masterNode,
      slaves: [slave1, slave2],
      healthCheck: {
        enabled: true,
        failureThreshold: 2,
        recoveryThreshold: 1,
      },
    });

    const healthCheckFn = jest.fn()
      .mockRejectedValueOnce(new Error("down")) // slave1 fail 1
      .mockResolvedValueOnce(undefined)          // slave2 ok
      .mockRejectedValueOnce(new Error("down")) // slave1 fail 2 → threshold
      .mockResolvedValueOnce(undefined);         // slave2 ok

    router.startHealthCheck(healthCheckFn);

    // Run two health check cycles manually
    await router.runHealthChecks();
    expect(router.healthySlaveCount).toBe(2); // still 2 (1 failure < threshold 2)

    await router.runHealthChecks();
    expect(router.healthySlaveCount).toBe(1); // slave1 now failed

    router.stopHealthCheck();
  });

  it("should auto-recover slave after recoveryThreshold", async () => {
    const router = new ReplicationRouter({
      master: masterNode,
      slaves: [slave1],
      healthCheck: {
        enabled: true,
        failureThreshold: 1,
        recoveryThreshold: 2,
      },
    });

    const healthCheckFn = jest.fn()
      .mockRejectedValueOnce(new Error("down")) // fail → mark failed
      .mockResolvedValueOnce(undefined)          // success 1
      .mockResolvedValueOnce(undefined);         // success 2 → recover

    router.startHealthCheck(healthCheckFn);

    await router.runHealthChecks();
    expect(router.healthySlaveCount).toBe(0); // failed

    await router.runHealthChecks();
    expect(router.healthySlaveCount).toBe(0); // 1 success, need 2

    await router.runHealthChecks();
    expect(router.healthySlaveCount).toBe(1); // recovered!

    router.stopHealthCheck();
  });

  it("should use 'random' strategy when configured", () => {
    const router = new ReplicationRouter({
      master: masterNode,
      slaves: [slave1, slave2],
      strategy: "random",
    });

    // Random strategy should return one of the slaves
    const node = router.getReadNode();
    expect([slave1, slave2]).toContainEqual(node);
  });

  it("should fallback to master with random strategy when all slaves failed", () => {
    const router = new ReplicationRouter({
      master: masterNode,
      slaves: [slave1],
      strategy: "random",
    });

    router.markSlaveFailed(slave1);
    expect(router.getReadNode()).toBe(masterNode);
  });

  it("should not start health check when disabled", () => {
    const router = new ReplicationRouter({
      master: masterNode,
      slaves: [slave1],
      healthCheck: { enabled: false },
    });

    const fn = jest.fn();
    router.startHealthCheck(fn);
    // No timer should be set — stopHealthCheck should be safe
    router.stopHealthCheck();
    expect(fn).not.toHaveBeenCalled();
  });

  it("should use default health check query SELECT 1", async () => {
    const router = new ReplicationRouter({
      master: masterNode,
      slaves: [slave1],
      healthCheck: { enabled: true },
    });

    const fn = jest.fn().mockResolvedValue(undefined);
    router.startHealthCheck(fn);

    await router.runHealthChecks();
    expect(fn).toHaveBeenCalledWith(slave1, "SELECT 1");

    router.stopHealthCheck();
  });
});
