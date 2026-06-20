/**
 * Metadata Module - Layered Metadata Store
 *
 * Hierarchical metadata management system modelled after Docker OverlayFS.
 *
 * The decorator-time source of truth is `MetadataLayerRegistry`
 * (`src/scanner/MetadataScanner.ts`). Use `MetadataLayerRegistry.getInstance()`
 * and `MetadataContext.run(tenantId, callback)` for tenant-scoped metadata.
 */

export * from "./MetadataLayer";
export * from "./MetadataPath";
export * from "./MetadataContext";
