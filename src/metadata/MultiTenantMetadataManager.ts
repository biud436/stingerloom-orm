import {
  LayeredMetadataStore,
  LayeredEntityScanner,
  LayeredColumnScanner,
} from "../metadata";

/**
 * Multi-tenant metadata manager.
 *
 * Enables managing an independent schema per tenant in a multi-tenant setup.
 */
export class MultiTenantMetadataManager {
  private store: LayeredMetadataStore;
  private entityScanner: LayeredEntityScanner;
  private columnScanner: LayeredColumnScanner;
  private currentTenant: string = "public";

  constructor() {
    this.store = new LayeredMetadataStore();
    this.entityScanner = new LayeredEntityScanner(this.store);
    this.columnScanner = new LayeredColumnScanner(this.store);
  }

  /**
   * Switch to a tenant.
   */
  switchTenant(tenantId: string): void {
    this.currentTenant = tenantId;
    this.store.setContext(tenantId);
  }

  /**
   * Create a new tenant (copies the public schema).
   */
  createTenant(tenantId: string, copyFrom: string = "public"): void {
    try {
      this.store.copyLayer(copyFrom, tenantId);
      console.log(`Tenant "${tenantId}" created from "${copyFrom}"`);
    } catch (error) {
      console.error(`Failed to create tenant "${tenantId}":`, error);
      throw error;
    }
  }

  /**
   * Register per-tenant entity metadata.
   */
  registerEntity(entityMetadata: any): void {
    const key = this.entityScanner.createUniqueKey();
    this.entityScanner.set(key, entityMetadata);
    console.log(
      `Entity registered in context "${this.currentTenant}": ${entityMetadata.name}`,
    );
  }

  /**
   * Register per-tenant column metadata.
   */
  registerColumn(columnMetadata: any): void {
    const key = this.columnScanner.createUniqueKey();
    this.columnScanner.set(key, columnMetadata);
  }

  /**
   * Return every entity in the current tenant.
   */
  getAllEntities(): any[] {
    return this.entityScanner.allMetadata();
  }

  /**
   * Look up a single entity from the merged view.
   */
  getEntity(target: any): any | null {
    return this.entityScanner.scan(target);
  }

  /**
   * Merge a tenant's schema (promote its changes into public).
   */
  promoteTenantSchemaToPublic(tenantId: string): void {
    this.store.mergeLayer(tenantId, "public");
    console.log(`Tenant "${tenantId}" schema promoted to public`);
  }

  /**
   * Delete a tenant.
   */
  removeTenant(tenantId: string): void {
    if (tenantId === "public") {
      throw new Error('Cannot remove "public" tenant');
    }
    this.store.removeLayer(tenantId);
    console.log(`Tenant "${tenantId}" removed`);
  }

  /**
   * Return info for every layer.
   */
  getLayersInfo() {
    return this.store.getLayersInfo();
  }

  /**
   * Return the current tenant info.
   */
  getCurrentTenant(): string {
    return this.currentTenant;
  }

  /**
   * Return the EntityScanner (legacy API compatibility).
   */
  getEntityScanner(): LayeredEntityScanner {
    return this.entityScanner;
  }

  /**
   * Return the ColumnScanner (legacy API compatibility).
   */
  getColumnScanner(): LayeredColumnScanner {
    return this.columnScanner;
  }

  /**
   * Return the internal store.
   */
  getStore(): LayeredMetadataStore {
    return this.store;
  }
}
