/**
 * Metadata Module - Layered Metadata Store
 *
 * Hierarchical metadata management system modelled after Docker OverlayFS.
 *
 * The decorator-time source of truth is `MetadataLayerRegistry`
 * (`src/scanner/MetadataScanner.ts`); the `LayeredMetadataStore`,
 * `LayeredMetadataScanner`, and `MultiTenantMetadataManager` exports below
 * are kept for backward compatibility and are **not** wired into the
 * EntityManager. New code should use `MetadataLayerRegistry.getInstance()`
 * and `MetadataContext.run(tenantId, callback)`. See issue #277.
 */

export * from "./MetadataLayer";
export * from "./MetadataPath";
export * from "./MetadataContext";
/** @deprecated See issue #277 — not the decorator-time registry. */
export * from "./LayeredMetadataStore";
/** @deprecated See issue #277 — not the decorator-time registry. */
export * from "./LayeredMetadataScanner";
/** @deprecated See issue #277 — not the decorator-time registry. */
export * from "./MultiTenantMetadataManager";
