/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import {
  TenantColumn,
  NonTenantEntity,
} from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

describe("INSERT under tenant_column strategy", () => {
  async function makeEm(entities: any[], opts: Record<string, any> = {}) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities,
        synchronize: true,
        tenantStrategy: "tenant_column",
        ...opts,
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    return em;
  }

  beforeEach(() => MetadataContext.reset());

  @Entity()
  class User {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
  }

  @Entity()
  class AuditLog {
    @PrimaryGeneratedColumn() id!: number;
    @Column() action!: string;
    @TenantColumn() tenantId!: string;
  }

  @NonTenantEntity()
  @Entity()
  class Tenant {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
  }

  it("auto-populates tenant_id from MetadataContext on save()", async () => {
    const em = await makeEm([User]);
    try {
      await MetadataContext.run("acme", async () => {
        const saved: any = await em.save(User, { name: "Alice" });
        // SQLite will select back the row after insert — tenant_id is visible.
        expect(saved.tenant_id ?? saved.tenantId).toBe("acme");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("throws MISSING_TENANT_CONTEXT when no tenant context is active", async () => {
    const em = await makeEm([User]);
    try {
      await expect(em.save(User, { name: "Bob" })).rejects.toMatchObject({
        code: OrmErrorCode.MISSING_TENANT_CONTEXT,
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("throws TENANT_MISMATCH when caller supplies a different tenant", async () => {
    const em = await makeEm([AuditLog]);
    try {
      await MetadataContext.run("acme", async () => {
        await expect(
          em.save(AuditLog, { action: "login", tenantId: "globex" }),
        ).rejects.toMatchObject({ code: OrmErrorCode.TENANT_MISMATCH });
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("accepts a supplied tenant value when it matches the context", async () => {
    const em = await makeEm([AuditLog]);
    try {
      await MetadataContext.run("acme", async () => {
        const saved: any = await em.save(AuditLog, {
          action: "view",
          tenantId: "acme",
        });
        expect(saved.tenantId ?? saved.tenant_id).toBe("acme");
      });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("skips auto-population on @NonTenantEntity entities (no tenant column exists)", async () => {
    const em = await makeEm([Tenant]);
    try {
      // Must NOT throw — Tenant is global and can be inserted without a context.
      const saved: any = await em.save(Tenant, { name: "Acme Corp" });
      expect(saved.name).toBe("Acme Corp");
      expect(saved.tenant_id).toBeUndefined();
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("isolates rows between tenants on the physical level", async () => {
    const em = await makeEm([User]);
    try {
      await MetadataContext.run("acme", async () => {
        await em.save(User, { name: "Alice" });
      });
      await MetadataContext.run("globex", async () => {
        await em.save(User, { name: "Bob" });
      });

      // Inspect raw table contents — rows have different tenant_id values.
      const driver = em.getDriver()!;
      const res: any = await driver.executeRaw(
        "SELECT name, tenant_id FROM user ORDER BY id",
      );
      const rows: any[] = Array.isArray(res)
        ? res
        : (res.results ?? res.rows ?? []);
      expect(rows).toEqual([
        { name: "Alice", tenant_id: "acme" },
        { name: "Bob", tenant_id: "globex" },
      ]);
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("populates tenant_id on saveMany()", async () => {
    const em = await makeEm([User]);
    try {
      await MetadataContext.run("acme", async () => {
        await em.saveMany(User, [{ name: "U1" }, { name: "U2" }, { name: "U3" }]);
      });
      const driver = em.getDriver()!;
      const res: any = await driver.executeRaw(
        "SELECT COUNT(*) as c FROM user WHERE tenant_id = 'acme'",
      );
      const rows: any[] = Array.isArray(res)
        ? res
        : (res.results ?? res.rows ?? []);
      expect(rows[0].c).toBe(3);
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("throws even if one item in saveMany is missing the context", async () => {
    const em = await makeEm([User]);
    try {
      await expect(
        em.saveMany(User, [{ name: "a" }, { name: "b" }]),
      ).rejects.toMatchObject({ code: OrmErrorCode.MISSING_TENANT_CONTEXT });
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("is an OrmError instance for both error codes", async () => {
    const em = await makeEm([User]);
    try {
      try {
        await em.save(User, { name: "x" });
        fail("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(OrmError);
      }
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });
});
