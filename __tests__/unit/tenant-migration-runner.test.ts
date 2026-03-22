/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  PostgresTenantMigrationRunner,
} from "../../src/dialects/postgres/PostgresTenantMigrationRunner";
import { TenantSyncResult } from "../../src/dialects/ITenantMigrationRunner";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { MySqlTenantMigrationRunner } from "../../src/dialects/mysql/MySqlTenantMigrationRunner";
import { SqliteTenantMigrationRunner } from "../../src/dialects/sqlite/SqliteTenantMigrationRunner";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

/**
 * PostgresDriver mock factory.
 * 실제 DB 연결 없이 PostgresTenantMigrationRunner의 동작을 검증합니다.
 */
function createMockDriver(options?: {
  schemas?: string[];
  tables?: string[];
}): jest.Mocked<PostgresDriver> {
  const existingSchemas = new Set(options?.schemas ?? ["public"]);
  const tables = (options?.tables ?? ["users", "posts"]).map((t) => ({
    tablename: t,
  }));

  const driver = {
    listSchemas: jest.fn().mockImplementation(() => {
      return Promise.resolve(
        Array.from(existingSchemas).map((s) => ({ schema_name: s })),
      );
    }),
    listTables: jest.fn().mockImplementation(() => {
      return Promise.resolve(tables);
    }),
    createSchema: jest.fn().mockImplementation((name: string) => {
      existingSchemas.add(name);
      return Promise.resolve([]);
    }),
    executeRaw: jest.fn().mockResolvedValue([]),
    hasSchema: jest.fn().mockImplementation((name?: string) => {
      const n = name ?? "public";
      if (existingSchemas.has(n)) {
        return Promise.resolve([{ schema_name: n }]);
      }
      return Promise.resolve([]);
    }),
    setSearchPath: jest.fn().mockResolvedValue([]),
    getSchema: jest.fn().mockReturnValue("public"),
  } as unknown as jest.Mocked<PostgresDriver>;

  return driver;
}

describe("PostgresTenantMigrationRunner", () => {
  describe("discoverSchemas()", () => {
    it("데이터베이스의 모든 사용자 스키마 목록을 반환해야 한다", async () => {
      const driver = createMockDriver({
        schemas: ["public", "tenant_a", "tenant_b"],
      });
      const runner = new PostgresTenantMigrationRunner(driver);

      const schemas = await runner.discoverSchemas();

      expect(schemas).toEqual(
        expect.arrayContaining(["public", "tenant_a", "tenant_b"]),
      );
      expect(schemas).toHaveLength(3);
      expect(driver.listSchemas).toHaveBeenCalledTimes(1);
    });

    it("사용자 스키마가 없으면 빈 배열을 반환해야 한다", async () => {
      const driver = createMockDriver({ schemas: [] });
      const runner = new PostgresTenantMigrationRunner(driver);

      const schemas = await runner.discoverSchemas();

      expect(schemas).toEqual([]);
    });
  });

  describe("ensureSchema()", () => {
    it("새 테넌트 스키마를 생성하고 테이블을 복제해야 한다", async () => {
      const driver = createMockDriver({ tables: ["users", "posts"] });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("tenant_a");

      expect(driver.createSchema).toHaveBeenCalledWith("tenant_a");
      expect(driver.listTables).toHaveBeenCalledWith("public");
      expect(driver.executeRaw).toHaveBeenCalledTimes(2);
      expect(driver.executeRaw).toHaveBeenCalledWith(
        expect.stringContaining('"tenant_a"."users"'),
      );
      expect(driver.executeRaw).toHaveBeenCalledWith(
        expect.stringContaining('"tenant_a"."posts"'),
      );
      expect(runner.isProvisioned("tenant_a")).toBe(true);
    });

    it("source 스키마(public)에 대해서는 no-op이어야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("public");

      expect(driver.createSchema).not.toHaveBeenCalled();
      expect(runner.isProvisioned("public")).toBe(false);
    });

    it("이미 프로비저닝된 스키마는 다시 생성하지 않아야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("tenant_a");
      await runner.ensureSchema("tenant_a");

      expect(driver.createSchema).toHaveBeenCalledTimes(1);
    });

    it("동시 호출 시 동일 스키마에 대한 중복 프로비저닝을 방지해야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      // 동시에 3개의 ensureSchema 호출
      await Promise.all([
        runner.ensureSchema("tenant_a"),
        runner.ensureSchema("tenant_a"),
        runner.ensureSchema("tenant_a"),
      ]);

      expect(driver.createSchema).toHaveBeenCalledTimes(1);
    });

    it("LIKE ... INCLUDING ALL 구문을 사용하여 테이블을 복제해야 한다", async () => {
      const driver = createMockDriver({ tables: ["orders"] });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("tenant_x");

      expect(driver.executeRaw).toHaveBeenCalledWith(
        'CREATE TABLE IF NOT EXISTS "tenant_x"."orders" (LIKE "public"."orders" INCLUDING ALL)',
      );
    });

    it("커스텀 sourceSchema를 사용할 수 있어야 한다", async () => {
      const driver = createMockDriver({ tables: ["items"] });
      const runner = new PostgresTenantMigrationRunner(driver, {
        sourceSchema: "template",
      });

      await runner.ensureSchema("tenant_y");

      expect(driver.listTables).toHaveBeenCalledWith("template");
      expect(driver.executeRaw).toHaveBeenCalledWith(
        'CREATE TABLE IF NOT EXISTS "tenant_y"."items" (LIKE "template"."items" INCLUDING ALL)',
      );
    });

    it("sourceSchema와 동일한 tenantId는 건너뛰어야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver, {
        sourceSchema: "base",
      });

      await runner.ensureSchema("base");

      expect(driver.createSchema).not.toHaveBeenCalled();
    });
  });

  describe("syncTenantSchemas()", () => {
    it("존재하지 않는 스키마만 생성해야 한다", async () => {
      const driver = createMockDriver({
        schemas: ["public", "tenant_a"],
        tables: ["users"],
      });
      const runner = new PostgresTenantMigrationRunner(driver);

      const result: TenantSyncResult = await runner.syncTenantSchemas([
        "tenant_a",
        "tenant_b",
        "tenant_c",
      ]);

      expect(result.created).toEqual(["tenant_b", "tenant_c"]);
      expect(result.skipped).toEqual(["tenant_a"]);

      // tenant_a는 이미 존재하므로 createSchema 호출 안함
      expect(driver.createSchema).toHaveBeenCalledWith("tenant_b");
      expect(driver.createSchema).toHaveBeenCalledWith("tenant_c");
      expect(driver.createSchema).not.toHaveBeenCalledWith("tenant_a");
    });

    it("모든 스키마가 이미 존재하면 아무것도 생성하지 않아야 한다", async () => {
      const driver = createMockDriver({
        schemas: ["public", "tenant_a", "tenant_b"],
      });
      const runner = new PostgresTenantMigrationRunner(driver);

      const result = await runner.syncTenantSchemas([
        "tenant_a",
        "tenant_b",
      ]);

      expect(result.created).toEqual([]);
      expect(result.skipped).toEqual(["tenant_a", "tenant_b"]);
      expect(driver.createSchema).not.toHaveBeenCalled();
    });

    it("빈 테넌트 목록에 대해 빈 결과를 반환해야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      const result = await runner.syncTenantSchemas([]);

      expect(result.created).toEqual([]);
      expect(result.skipped).toEqual([]);
    });

    it("sourceSchema(public)는 건너뛰어야 한다", async () => {
      const driver = createMockDriver({ schemas: ["public"] });
      const runner = new PostgresTenantMigrationRunner(driver);

      const result = await runner.syncTenantSchemas(["public", "tenant_new"]);

      expect(result.skipped).toContain("public");
      expect(result.created).toContain("tenant_new");
      expect(driver.createSchema).toHaveBeenCalledTimes(1);
    });

    it("sync 후 모든 테넌트가 provisioned 상태여야 한다", async () => {
      const driver = createMockDriver({ schemas: ["public"] });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.syncTenantSchemas(["tenant_a", "tenant_b"]);

      expect(runner.isProvisioned("tenant_a")).toBe(true);
      expect(runner.isProvisioned("tenant_b")).toBe(true);
    });

    it("sync 후 getProvisionedSchemas로 목록을 조회할 수 있어야 한다", async () => {
      const driver = createMockDriver({
        schemas: ["public", "existing"],
      });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.syncTenantSchemas(["existing", "new_one"]);

      const provisioned = runner.getProvisionedSchemas();
      expect(provisioned).toContain("existing");
      expect(provisioned).toContain("new_one");
    });
  });

  describe("getProvisionedSchemas()", () => {
    it("프로비저닝된 스키마 목록을 반환해야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("tenant_a");
      await runner.ensureSchema("tenant_b");

      const schemas = runner.getProvisionedSchemas();
      expect(schemas).toEqual(
        expect.arrayContaining(["tenant_a", "tenant_b"]),
      );
      expect(schemas).toHaveLength(2);
    });

    it("초기 상태에서는 빈 배열이어야 한다", () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      expect(runner.getProvisionedSchemas()).toEqual([]);
    });
  });

  describe("reset()", () => {
    it("프로비저닝 상태를 초기화해야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("tenant_a");
      expect(runner.isProvisioned("tenant_a")).toBe(true);

      runner.reset();
      expect(runner.isProvisioned("tenant_a")).toBe(false);
      expect(runner.getProvisionedSchemas()).toEqual([]);
    });

    it("reset 후 동일 스키마를 다시 프로비저닝할 수 있어야 한다", async () => {
      const driver = createMockDriver();
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("tenant_a");
      runner.reset();
      await runner.ensureSchema("tenant_a");

      expect(driver.createSchema).toHaveBeenCalledTimes(2);
    });
  });

  describe("identifier escaping", () => {
    it("큰따옴표가 포함된 스키마 이름을 이중 이스케이프해야 한다", async () => {
      const driver = createMockDriver({ tables: ["data"] });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema('ten"ant');

      expect(driver.executeRaw).toHaveBeenCalledWith(
        'CREATE TABLE IF NOT EXISTS "ten""ant"."data" (LIKE "public"."data" INCLUDING ALL)',
      );
    });

    it("큰따옴표가 포함된 테이블 이름도 이중 이스케이프해야 한다", async () => {
      const driver = createMockDriver({ tables: ['my"table'] });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("safe_tenant");

      expect(driver.executeRaw).toHaveBeenCalledWith(
        'CREATE TABLE IF NOT EXISTS "safe_tenant"."my""table" (LIKE "public"."my""table" INCLUDING ALL)',
      );
    });
  });

  describe("error handling", () => {
    it("스키마 생성 실패 시 에러를 전파해야 한다", async () => {
      const driver = createMockDriver();
      driver.createSchema = jest
        .fn()
        .mockRejectedValue(new Error("permission denied"));
      const runner = new PostgresTenantMigrationRunner(driver);

      await expect(runner.ensureSchema("forbidden")).rejects.toThrow(
        "permission denied",
      );
    });

    it("테이블 복제 실패 시 에러를 전파해야 한다", async () => {
      const driver = createMockDriver({ tables: ["fail_table"] });
      driver.executeRaw = jest
        .fn()
        .mockRejectedValue(new Error("table clone failed"));
      const runner = new PostgresTenantMigrationRunner(driver);

      await expect(runner.ensureSchema("broken")).rejects.toThrow(
        "table clone failed",
      );
    });

    it("provision 실패 후 재시도가 가능해야 한다 (#98)", async () => {
      const driver = createMockDriver({ tables: ["users"] });
      let callCount = 0;
      driver.createSchema = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("transient DB timeout"));
        }
        return Promise.resolve([]);
      });
      const runner = new PostgresTenantMigrationRunner(driver);

      // 첫 번째 호출: 실패
      await expect(runner.ensureSchema("tenant_retry")).rejects.toThrow(
        "transient DB timeout",
      );
      expect(runner.isProvisioned("tenant_retry")).toBe(false);

      // 두 번째 호출: 락이 정리되었으므로 재시도 성공해야 함
      await runner.ensureSchema("tenant_retry");
      expect(runner.isProvisioned("tenant_retry")).toBe(true);
      expect(driver.createSchema).toHaveBeenCalledTimes(2);
    });

    it("동시 호출 중 실패 시 lock이 정리되어야 한다 (#98)", async () => {
      const driver = createMockDriver({ tables: ["t1"] });
      driver.createSchema = jest
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue([]);
      const runner = new PostgresTenantMigrationRunner(driver);

      // 동시 호출 — 첫 번째 provision이 실패하면 모두 reject
      const results = await Promise.allSettled([
        runner.ensureSchema("tenant_c"),
        runner.ensureSchema("tenant_c"),
      ]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);

      // lock이 정리되었으므로 재시도 성공
      await runner.ensureSchema("tenant_c");
      expect(runner.isProvisioned("tenant_c")).toBe(true);
    });

    it("syncTenantSchemas 중 실패 시 이미 생성된 스키마는 유지되어야 한다", async () => {
      const driver = createMockDriver({
        schemas: ["public"],
        tables: ["t1"],
      });
      let callCount = 0;
      driver.createSchema = jest.fn().mockImplementation((name: string) => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error("second schema failed"));
        }
        return Promise.resolve([]);
      });
      const runner = new PostgresTenantMigrationRunner(driver);

      await expect(
        runner.syncTenantSchemas(["ok_tenant", "fail_tenant"]),
      ).rejects.toThrow("second schema failed");

      // 첫 번째 스키마는 프로비저닝 완료됨
      expect(runner.isProvisioned("ok_tenant")).toBe(true);
      expect(runner.isProvisioned("fail_tenant")).toBe(false);
    });
  });

  describe("source schema with tables", () => {
    it("원본 스키마에 테이블이 없으면 빈 스키마만 생성해야 한다", async () => {
      const driver = createMockDriver({ tables: [] });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("empty_tenant");

      expect(driver.createSchema).toHaveBeenCalledWith("empty_tenant");
      expect(driver.executeRaw).not.toHaveBeenCalled();
      expect(runner.isProvisioned("empty_tenant")).toBe(true);
    });

    it("많은 테이블이 있는 경우 모두 복제해야 한다", async () => {
      const tables = Array.from({ length: 20 }, (_, i) => `table_${i}`);
      const driver = createMockDriver({ tables });
      const runner = new PostgresTenantMigrationRunner(driver);

      await runner.ensureSchema("big_tenant");

      expect(driver.executeRaw).toHaveBeenCalledTimes(20);
      for (const t of tables) {
        expect(driver.executeRaw).toHaveBeenCalledWith(
          expect.stringContaining(`"big_tenant"."${t}"`),
        );
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 미지원 드라이버 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe.each([
  ["MySqlTenantMigrationRunner", () => new MySqlTenantMigrationRunner()],
  ["SqliteTenantMigrationRunner", () => new SqliteTenantMigrationRunner()],
])("%s", (_name, factory) => {
  const methods = [
    "discoverSchemas",
    "ensureSchema",
    "syncTenantSchemas",
    "isProvisioned",
    "getProvisionedSchemas",
    "reset",
  ] as const;

  it.each(methods)("%s()는 OrmError(UNSUPPORTED_DATABASE)를 throw해야 한다", (method) => {
    const runner = factory();
    expect(() => (runner as any)[method]("test")).toThrow();
    try {
      (runner as any)[method]("test");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_DATABASE);
    }
  });
});
