/**
 * Layered metadata public surface.
 *
 * Declared as explicit named re-exports (no `export *`) so that adding an
 * export to an internal module does not silently widen this subpath's API.
 */

export { MetadataContext } from "./MetadataContext";
export { MetadataLayer } from "./MetadataLayer";
