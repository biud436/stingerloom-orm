/**
 * Regression test for issue #280:
 * decorator-time metadata writes must always target the shared "public" layer,
 * even when class declarations evaluate inside a `MetadataContext.run(tenantId, ...)`
 * block (dynamic entity factories, IntrospectionGenerator under a request handler,
 * test fixtures spawning entities per tenant).
 */

import "reflect-metadata";

import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToMany } from "../../src/decorators/OneToMany";
import { OneToOne } from "../../src/decorators/OneToOne";
import { ManyToMany } from "../../src/decorators/ManyToMany";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import {
  EntityScanner,
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  OneToOneScanner,
  ManyToManyScanner,
} from "../../src/scanner";
import {
  getScannerInstance,
  resetScannerContainer,
} from "../../src/scanner/ScannerContainer";

function resetAll() {
  MetadataContext.reset();
  MetadataLayerRegistry.reset();
  resetScannerContainer();
}

describe("Decorator metadata always routes to the public layer (#280)", () => {
  beforeEach(() => resetAll());

  it("@Entity declared inside MetadataContext.run(tenant) registers on public", async () => {
    await MetadataContext.run("acme", async () => {
      @Entity()
      class TenantScopedEntity {
        @PrimaryGeneratedColumn()
        id!: number;
      }

      // Sanity: we are still inside the tenant context.
      expect(MetadataContext.getCurrentTenant()).toBe("acme");

      const registry = MetadataLayerRegistry.getInstance();
      const publicLayer = registry.getLayer("public");
      const tenantLayer = registry.getLayer("acme");

      expect(publicLayer).toBeDefined();

      // The decorator must have written to public, not the active tenant layer.
      const publicEntries = publicLayer!
        .entries<{ target?: Function; rawClassName?: string }>()
        .filter(
          ([, v]) =>
            v && typeof v === "object" && v.target === TenantScopedEntity,
        );
      expect(publicEntries.length).toBe(1);

      // The tenant layer must not own the entity registration.
      if (tenantLayer) {
        const tenantOwned = tenantLayer
          .entries<{ target?: Function }>()
          .filter(
            ([, v]) =>
              v && typeof v === "object" && v.target === TenantScopedEntity,
          );
        expect(tenantOwned.length).toBe(0);
      }
    });
  });

  it("@Column declared inside MetadataContext.run(tenant) registers on public", async () => {
    await MetadataContext.run("acme", async () => {
      @Entity()
      class WithColumn {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar" })
        name!: string;
      }

      // `@Column` decorates the prototype, so the metadata's `target` is
      // `WithColumn.prototype` rather than the class constructor.
      const proto = WithColumn.prototype;

      const registry = MetadataLayerRegistry.getInstance();
      const publicLayer = registry.getLayer("public");
      const tenantLayer = registry.getLayer("acme");

      const publicCols = publicLayer!
        .entries<{ target?: object; name?: string }>()
        .filter(
          ([k, v]) =>
            k.startsWith("columns::") &&
            v &&
            typeof v === "object" &&
            v.target === proto,
        );
      expect(publicCols.length).toBeGreaterThanOrEqual(1);
      expect(publicCols.some(([, v]) => v.name === "name")).toBe(true);

      if (tenantLayer) {
        const tenantCols = tenantLayer
          .entries<{ target?: object }>()
          .filter(
            ([k, v]) =>
              k.startsWith("columns::") &&
              v &&
              typeof v === "object" &&
              v.target === proto,
          );
        expect(tenantCols.length).toBe(0);
      }
    });
  });

  it("relation decorators declared inside a tenant context register on public", async () => {
    await MetadataContext.run("acme", async () => {
      @Entity()
      class Author {
        @PrimaryGeneratedColumn()
        id!: number;
      }

      @Entity()
      class Profile {
        @PrimaryGeneratedColumn()
        id!: number;
      }

      @Entity()
      class Tag {
        @PrimaryGeneratedColumn()
        id!: number;
      }

      class Comment {}

      @Entity()
      class Article {
        @PrimaryGeneratedColumn()
        id!: number;

        @ManyToOne(
          () => Author,
          (entity: any) => entity.author,
          { joinColumn: "author_id" },
        )
        author!: Author;

        @OneToMany(() => Comment, { mappedBy: "article" })
        comments!: Comment[];

        @OneToOne(() => Profile, { joinColumn: "profile_id" })
        profile!: Profile;

        @ManyToMany(() => Tag)
        tags!: Tag[];
      }

      const registry = MetadataLayerRegistry.getInstance();
      const publicLayer = registry.getLayer("public");
      const tenantLayer = registry.getLayer("acme");

      const ownedBy = (
        layer: ReturnType<MetadataLayerRegistry["getLayer"]>,
        prefix: string,
      ) =>
        layer
          ?.entries<{ target?: Function }>()
          .filter(
            ([k, v]) =>
              k.startsWith(prefix) &&
              v &&
              typeof v === "object" &&
              v.target === Article,
          ) ?? [];

      // Scanner prefixes (see EntityScanner/ColumnScanner/etc. constructors):
      //   ManyToOneScanner    → "relations"
      //   OneToManyScanner    → "oneToManyRelations"
      //   OneToOneScanner     → "oneToOneRelations"
      //   ManyToManyScanner   → "manyToManyRelations"
      expect(ownedBy(publicLayer!, "relations::").length).toBe(1);
      expect(ownedBy(publicLayer!, "oneToManyRelations::").length).toBe(1);
      expect(ownedBy(publicLayer!, "oneToOneRelations::").length).toBe(1);
      expect(ownedBy(publicLayer!, "manyToManyRelations::").length).toBe(1);

      // None of them leak into the tenant layer.
      if (tenantLayer) {
        expect(ownedBy(tenantLayer, "relations::").length).toBe(0);
        expect(ownedBy(tenantLayer, "oneToManyRelations::").length).toBe(0);
        expect(ownedBy(tenantLayer, "oneToOneRelations::").length).toBe(0);
        expect(ownedBy(tenantLayer, "manyToManyRelations::").length).toBe(0);
      }
    });
  });

  it("entity defined under tenant_a is visible to tenant_b via public fallback", async () => {
    let DefinedUnderTenantA!: Function;
    let definedProto!: object;

    await MetadataContext.run("tenant_a", async () => {
      @Entity()
      class TenantADefined {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar" })
        slug!: string;
      }

      DefinedUnderTenantA = TenantADefined;
      definedProto = TenantADefined.prototype;
    });

    // Switching to a sibling tenant must still see the entity (it lives on public).
    await MetadataContext.run("tenant_b", async () => {
      const entityScanner = getScannerInstance(EntityScanner);
      const found = entityScanner.scan(DefinedUnderTenantA as any);
      expect(found).not.toBeNull();
      expect((found as any).target).toBe(DefinedUnderTenantA);

      const columnScanner = getScannerInstance(ColumnScanner);
      const cols = columnScanner.allMetadata<{
        target?: object;
        name?: string;
      }>();
      const entityCols = cols.filter((c) => c.target === definedProto);
      expect(entityCols.some((c) => c.name === "slug")).toBe(true);
    });
  });

  it("setOnPublic cache invalidation reaches every tenant context", () => {
    const registry = MetadataLayerRegistry.getInstance();

    // Prime caches for two tenant contexts.
    registry.setContext("tenant_a");
    const cacheA1 = registry.resolveAll();
    registry.setContext("tenant_b");
    const cacheB1 = registry.resolveAll();
    registry.setContext("public");

    // Decorator-time write under a tenant context still hits public,
    // and dirties every tenant cache.
    MetadataContext.run("tenant_a", () => {
      @Entity()
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      class LateEntity {
        @PrimaryGeneratedColumn()
        id!: number;
      }
    });

    registry.setContext("tenant_a");
    expect(registry.resolveAll()).not.toBe(cacheA1);
    registry.setContext("tenant_b");
    expect(registry.resolveAll()).not.toBe(cacheB1);
  });

  it("MetadataScanner.set() (non-decorator API) still respects current context", () => {
    // Guards against a regression where setOnPublic accidentally replaces set().
    // Tenant-specific overrides must keep working for Copy-on-Write callers
    // that explicitly switch context.
    const registry = MetadataLayerRegistry.getInstance();
    const scanner = getScannerInstance(EntityScanner);

    registry.setContext("tenant_x");
    scanner.set("explicit_override", { target: class T {}, name: "x" });

    const tenantLayer = registry.getLayer("tenant_x");
    expect(
      tenantLayer
        ?.entries()
        .find(([k]) => k === "entities::explicit_override"),
    ).toBeDefined();

    const publicLayer = registry.getLayer("public");
    expect(
      publicLayer
        ?.entries()
        .find(([k]) => k === "entities::explicit_override"),
    ).toBeUndefined();
  });

  // Touch every named scanner so static imports are not pruned.
  it("scanner singletons resolve without throwing", () => {
    expect(getScannerInstance(EntityScanner)).toBeDefined();
    expect(getScannerInstance(ColumnScanner)).toBeDefined();
    expect(getScannerInstance(ManyToOneScanner)).toBeDefined();
    expect(getScannerInstance(OneToManyScanner)).toBeDefined();
    expect(getScannerInstance(OneToOneScanner)).toBeDefined();
    expect(getScannerInstance(ManyToManyScanner)).toBeDefined();
  });
});
