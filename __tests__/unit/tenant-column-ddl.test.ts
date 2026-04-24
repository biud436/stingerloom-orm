/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column, COLUMN_TOKEN } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import {
  TenantColumn,
  NonTenantEntity,
} from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";

describe("DDL auto-injection under tenant_column strategy", () => {
  async function makeEm(entities: any[], options: Record<string, any> = {}) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities,
        synchronize: true,
        tenantStrategy: "tenant_column",
        ...options,
      },
      // unique per test to avoid DatabaseClient connection cache collisions
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    return em;
  }

  it("adds a tenant_id column to tenant-scoped entities (implicit)", async () => {
    @Entity()
    class User {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    const em = await makeEm([User]);
    try {
      const cols = (Reflect.getMetadata(COLUMN_TOKEN, User.prototype) ??
        []) as any[];
      const names = cols.map((c) => c.name);
      expect(names).toContain("tenant_id");

      const tenantCol = cols.find((c) => c.name === "tenant_id");
      expect(tenantCol.options.type).toBe("varchar");
      expect(tenantCol.options.length).toBe(64);
      expect(tenantCol.options.nullable).toBe(false);
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("skips entities marked @NonTenantEntity", async () => {
    @NonTenantEntity()
    @Entity()
    class Tenant {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    const em = await makeEm([Tenant]);
    try {
      const cols = (Reflect.getMetadata(COLUMN_TOKEN, Tenant.prototype) ??
        []) as any[];
      const names = cols.map((c) => c.name);
      expect(names).not.toContain("tenant_id");
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does not duplicate when user declared @TenantColumn explicitly", async () => {
    @Entity()
    class AuditLog {
      @PrimaryGeneratedColumn() id!: number;
      @Column() action!: string;
      @TenantColumn() tenantId!: string;
    }

    const em = await makeEm([AuditLog]);
    try {
      const cols = (Reflect.getMetadata(COLUMN_TOKEN, AuditLog.prototype) ??
        []) as any[];
      // Should have exactly ONE tenant column, coming from @TenantColumn.
      const tenantMatches = cols.filter(
        (c) => c.name === "tenant_id" || c.propertyKey === "tenantId",
      );
      expect(tenantMatches.length).toBe(1);
      // And the declared property key must be the user's "tenantId".
      expect(tenantMatches[0].propertyKey).toBe("tenantId");
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("respects a custom tenantColumnName", async () => {
    @Entity()
    class OrgScoped {
      @PrimaryGeneratedColumn() id!: number;
      @Column() label!: string;
    }

    const em = await makeEm([OrgScoped], { tenantColumnName: "org_id" });
    try {
      const cols = (Reflect.getMetadata(COLUMN_TOKEN, OrgScoped.prototype) ??
        []) as any[];
      const names = cols.map((c) => c.name);
      expect(names).toContain("org_id");
      expect(names).not.toContain("tenant_id");
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("supports uuid tenant column type (no length)", async () => {
    @Entity()
    class UuidScoped {
      @PrimaryGeneratedColumn() id!: number;
      @Column() foo!: string;
    }

    const em = await makeEm([UuidScoped], { tenantColumnType: "uuid" });
    try {
      const cols = (Reflect.getMetadata(COLUMN_TOKEN, UuidScoped.prototype) ??
        []) as any[];
      const tenantCol = cols.find((c) => c.name === "tenant_id");
      expect(tenantCol).toBeDefined();
      expect(tenantCol.options.type).toBe("uuid");
      expect(tenantCol.options.length).toBeUndefined();
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("does nothing when strategy is not 'tenant_column'", async () => {
    @Entity()
    class Plain {
      @PrimaryGeneratedColumn() id!: number;
      @Column() name!: string;
    }

    // Use default strategy
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [Plain],
        synchronize: true,
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    try {
      const cols = (Reflect.getMetadata(COLUMN_TOKEN, Plain.prototype) ??
        []) as any[];
      const names = cols.map((c) => c.name);
      expect(names).not.toContain("tenant_id");
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("creates the sqlite table successfully with the injected column", async () => {
    @Entity()
    class Thing {
      @PrimaryGeneratedColumn() id!: number;
      @Column() label!: string;
    }

    const em = await makeEm([Thing]);
    try {
      const driver = em.getDriver()!;
      // Inspect actual sqlite schema: PRAGMA table_info returns column list.
      const result: any = await driver.executeRaw("PRAGMA table_info('thing')");
      const rows: any[] = Array.isArray(result)
        ? result
        : (result.results ?? result.rows ?? []);
      const colNames = rows.map((r) => r.name);
      expect(colNames).toContain("tenant_id");
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });
});
