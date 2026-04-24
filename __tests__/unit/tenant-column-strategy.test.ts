import "reflect-metadata";
import {
  TenantColumnStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
} from "../../src/core/TenantQueryStrategy";
import { MetadataContext } from "../../src/metadata/MetadataContext";

const wrap = (s: string) => `"${s}"`;

describe("TenantColumnStrategy", () => {
  beforeEach(() => {
    MetadataContext.reset();
  });

  it("does not qualify table names (tenant lives in column, not schema)", () => {
    const s = new TenantColumnStrategy();
    expect(s.qualifyTable("users", "acme", wrap)).toBe(`"users"`);
    expect(s.qualifyTable("users", "public", wrap)).toBe(`"users"`);
  });

  it("does not need a transaction for tenant reads", () => {
    expect(new TenantColumnStrategy().needsTransactionForTenantRead()).toBe(false);
  });

  it("returns null predicate when context is 'public'", () => {
    const s = new TenantColumnStrategy();
    expect(s.buildTenantPredicate(null, wrap)).toBeNull();
  });

  it("returns null predicate when context is unscoped", async () => {
    const s = new TenantColumnStrategy();
    await MetadataContext.run("acme", async () => {
      await MetadataContext.runUnscoped(async () => {
        expect(s.buildTenantPredicate(null, wrap)).toBeNull();
      });
    });
  });

  it("builds an unaliased predicate inside a tenant context", async () => {
    const s = new TenantColumnStrategy();
    await MetadataContext.run("acme", async () => {
      expect(s.buildTenantPredicate(null, wrap)).toEqual({
        sql: `"tenant_id" = ?`,
        param: "acme",
      });
    });
  });

  it("builds an aliased predicate when a table alias is provided (for JOINs)", async () => {
    const s = new TenantColumnStrategy();
    await MetadataContext.run("globex", async () => {
      expect(s.buildTenantPredicate("u", wrap)).toEqual({
        sql: `"u"."tenant_id" = ?`,
        param: "globex",
      });
    });
  });

  it("respects a custom tenant column name", async () => {
    const s = new TenantColumnStrategy("org_id");
    await MetadataContext.run("acme", async () => {
      expect(s.buildTenantPredicate(null, wrap)).toEqual({
        sql: `"org_id" = ?`,
        param: "acme",
      });
    });
    expect(s.getTenantColumnName()).toBe("org_id");
  });

  it("returns the predicate on each call (does not cache across contexts)", async () => {
    const s = new TenantColumnStrategy();
    await MetadataContext.run("t1", async () => {
      expect(s.buildTenantPredicate(null, wrap)?.param).toBe("t1");
    });
    await MetadataContext.run("t2", async () => {
      expect(s.buildTenantPredicate(null, wrap)?.param).toBe("t2");
    });
  });
});

describe("Other strategies do not implement buildTenantPredicate", () => {
  it("SearchPathStrategy returns nothing from the optional predicate method", () => {
    const s = new SearchPathStrategy() as { buildTenantPredicate?: unknown };
    expect(s.buildTenantPredicate).toBeUndefined();
  });

  it("SchemaQualifiedStrategy returns nothing from the optional predicate method", () => {
    const s = new SchemaQualifiedStrategy() as { buildTenantPredicate?: unknown };
    expect(s.buildTenantPredicate).toBeUndefined();
  });
});

describe("MetadataContext.runUnscoped", () => {
  beforeEach(() => {
    MetadataContext.reset();
  });

  it("sets isUnscoped() true inside the callback", async () => {
    await MetadataContext.run("acme", async () => {
      expect(MetadataContext.isUnscoped()).toBe(false);
      await MetadataContext.runUnscoped(async () => {
        expect(MetadataContext.isUnscoped()).toBe(true);
      });
      expect(MetadataContext.isUnscoped()).toBe(false);
    });
  });

  it("preserves the tenant id (INSERTs still have a tenant to use)", async () => {
    await MetadataContext.run("acme", async () => {
      await MetadataContext.runUnscoped(async () => {
        expect(MetadataContext.getCurrentTenant()).toBe("acme");
      });
    });
  });

  it("defaults tenant to 'public' when called outside any run() block", async () => {
    await MetadataContext.runUnscoped(async () => {
      expect(MetadataContext.getCurrentTenant()).toBe("public");
      expect(MetadataContext.isUnscoped()).toBe(true);
    });
  });

  it("does not leak the unscoped flag to sibling async branches", async () => {
    const results: { branch: string; unscoped: boolean }[] = [];
    await MetadataContext.run("acme", async () => {
      await Promise.all([
        MetadataContext.runUnscoped(async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.push({ branch: "A", unscoped: MetadataContext.isUnscoped() });
        }),
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.push({ branch: "B", unscoped: MetadataContext.isUnscoped() });
        })(),
      ]);
    });
    expect(results).toContainEqual({ branch: "A", unscoped: true });
    expect(results).toContainEqual({ branch: "B", unscoped: false });
  });
});
