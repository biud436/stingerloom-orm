/**
 * Single home for every probe into UNDOCUMENTED internals of the underlying
 * DB client libraries. Nothing else in the codebase may reach into pg/mysql2
 * private fields — when a driver upgrade renames or removes one of these
 * flags, this file is the only place to adjust, and the fallback below keeps
 * the ORM functional (a stale-but-alive verdict is recoverable: the pool's
 * ping/error handling replaces a truly dead connection on next use).
 *
 * Known probes:
 * - pg `PoolClient._ending` — set once `end()` starts; no public equivalent.
 * - mysql2 `PoolConnection.destroyed` — set by `destroy()`; not in the docs
 *   or the type definitions, but stable across mysql2 majors.
 */

/**
 * Reads a boolean-ish internal flag off a raw client object.
 * Returns `false` when the object is missing or the field is absent —
 * i.e. an unknown client shape is presumed NOT to have the flag set, so
 * `isAlive()` degrades to "alive" instead of poisoning every connection.
 */
export function readInternalFlag(raw: unknown, field: string): boolean {
  if (raw === null || typeof raw !== "object") return false;
  return (raw as Record<string, unknown>)[field] === true;
}
