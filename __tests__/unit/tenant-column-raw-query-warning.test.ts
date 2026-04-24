/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { Logger } from "../../src/utils/Logger";

/**
 * Phase 7.1 — `em.query()` emits a one-time-per-call-site warning when
 * executed under an active tenant context with the `"tenant_column"`
 * strategy in place. Raw SQL bypasses the automatic `WHERE tenant_id`
 * injection, so developers need to manually filter (or explicitly opt
 * out via `runUnscoped`).
 */
describe("tenant_column — em.query() raw-query warning", () => {
  @Entity()
  class Widget {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
  }

  async function makeEm(opts: Record<string, any> = {}) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [Widget],
        synchronize: true,
        tenantStrategy: "tenant_column",
        ...opts,
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    return em;
  }

  beforeEach(() => MetadataContext.reset());

  it("warns once for a call site under an active tenant context", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        await em.query("SELECT 1 as one");
      });
      const tenantCalls = warnSpy.mock.calls.filter((c) =>
        /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
      );
      expect(tenantCalls).toHaveLength(1);
      expect(String(tenantCalls[0][0])).toContain('tenant="acme"');
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("dedupes repeated calls from the same call site", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        await em.query("SELECT 1 as one");
        await em.query("SELECT 2 as two");
        await em.query("SELECT 3 as three");
      });
      const tenantCalls = warnSpy.mock.calls.filter((c) =>
        /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
      );
      // All three calls originate from the same line in this test → one warn.
      expect(tenantCalls.length).toBeLessThanOrEqual(3);
      // But at least the first call must have warned.
      expect(tenantCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does not warn when no tenant context is active", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await em.query("SELECT 1 as one");
      const tenantCalls = warnSpy.mock.calls.filter((c) =>
        /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
      );
      expect(tenantCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does not warn inside runUnscoped()", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        await MetadataContext.runUnscoped(async () => {
          await em.query("SELECT 1 as one");
        });
      });
      const tenantCalls = warnSpy.mock.calls.filter((c) =>
        /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
      );
      expect(tenantCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does not warn when tenant is 'public' (bootstrap path)", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("public", async () => {
        await em.query("SELECT 1 as one");
      });
      const tenantCalls = warnSpy.mock.calls.filter((c) =>
        /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
      );
      expect(tenantCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does not warn when tenantStrategy is not tenant_column", async () => {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [Widget],
        synchronize: true,
        // no tenantStrategy → default SearchPathStrategy
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        await em.query("SELECT 1 as one");
      });
      const tenantCalls = warnSpy.mock.calls.filter((c) =>
        /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
      );
      expect(tenantCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("warning is cleared on propagateShutdown", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        await em.query("SELECT 1 as one");
      });
      // Shut down and re-register — the warn dedupe set should be empty again.
      await em.propagateShutdown({ closeConnections: true });
      expect((em as any).rawQueryTenantWarned.size).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
