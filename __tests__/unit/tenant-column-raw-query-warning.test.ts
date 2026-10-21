/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { NonTenantEntity } from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
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

  @NonTenantEntity()
  @Entity()
  class SharedTag {
    @PrimaryGeneratedColumn() id!: number;
    @Column() label!: string;
  }

  function rawQueryWarnings(warnSpy: jest.SpyInstance): string[] {
    return warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /\[multi-tenancy\] em\.query\(\)/.test(m));
  }

  async function makeEm(opts: Record<string, any> = {}) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [Widget, SharedTag],
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

  it("warns once per call site, and again for a different call site", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        for (let i = 0; i < 3; i++) await em.query("SELECT 1 as one");
        expect(rawQueryWarnings(warnSpy)).toHaveLength(1);
        await em.query("SELECT 2 as two");
      });
      const warnings = rawQueryWarnings(warnSpy);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("tenant-column-raw-query-warning.test.ts");
      expect(warnings[0]).not.toBe(warnings[1]);
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does not warn for the statements the query builder runs", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        await em.save(Widget, { name: "a" });
        const qb = () => em.createQueryBuilder(Widget, "w");
        await qb().getMany();
        await qb().getOne();
        await qb().getCount();
        await qb().getRawMany();
        await qb().exists();
        await qb().paginate({ page: 1, pageSize: 10 });
        for await (const row of qb().stream()) void row;
        await qb().cache().getMany();
        await qb().prepare().execute({});
        await qb().preparePartial().execute({});
        await qb().explain();
        await qb().withoutTenantScope().getMany();
      });
      expect(rawQueryWarnings(warnSpy)).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does not warn for the write buffer's savepoints and batched updates", async () => {
    const base = await makeEm();
    const em = base.extend(bufferPlugin()) as any;
    const warnSpy = jest.spyOn((base as any).logger as Logger, "warn");
    try {
      await MetadataContext.run("acme", async () => {
        await em.save(SharedTag, { label: "x" });
        await em.save(SharedTag, { label: "y" });

        const nested = em.buffer().beginNested();
        nested.persist(Object.assign(new Widget(), { name: "nested" }));
        await nested.flush();

        const buf = em.buffer({ batchUpdate: true });
        const tags = await buf.find(SharedTag);
        for (const tag of tags) tag.label += "!";
        const result = await buf.flush();
        expect(result.updates).toBe(2);
      });
      expect(rawQueryWarnings(warnSpy)).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      await base.propagateShutdown({ closeConnections: true });
    }
  });

  it("names the caller's frame when the ORM and the app share one bundled file", async () => {
    const em = await makeEm();
    const warnSpy = jest.spyOn((em as any).logger as Logger, "warn");
    const original = Error.prepareStackTrace;
    // Every frame reports the same file, as in a single-file bundle.
    Error.prepareStackTrace = (error, callSites) =>
      [
        String(error),
        ...callSites.map(
          (site) =>
            `    at ${site.getFunctionName() ?? "<anonymous>"} ` +
            `(/app/dist/main.js:${site.getLineNumber()}:${site.getColumnNumber()})`,
        ),
      ].join("\n");
    try {
      await MetadataContext.run("acme", async () => {
        await em.createQueryBuilder(Widget, "w").getMany();
        await em.createQueryBuilder(Widget, "w").getCount();
        expect(rawQueryWarnings(warnSpy)).toHaveLength(0);

        for (let i = 0; i < 2; i++) await em.query("SELECT 1 as one");
        await em.query("SELECT 2 as two");
      });
      Error.prepareStackTrace = original;
      const warnings = rawQueryWarnings(warnSpy);
      expect(warnings).toHaveLength(2);
      for (const warning of warnings) {
        expect(warning).toContain("/app/dist/main.js");
        expect(warning).not.toMatch(/warnIfRawQueryBypassesTenant|runRawQuery|query \(/);
      }
      expect(warnings[0]).not.toBe(warnings[1]);
    } finally {
      Error.prepareStackTrace = original;
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
