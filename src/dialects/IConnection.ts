/**
 * Generic connection interface for all database dialects.
 *
 * Each dialect wraps its native connection type (e.g., mysql2 PoolConnection,
 * pg PoolClient) behind this interface, providing a uniform API for
 * acquiring, releasing, and inspecting connections.
 *
 * @template TRaw The underlying driver-specific connection type.
 */
export interface IConnection<TRaw = unknown> {
  /**
   * Returns the underlying driver-specific connection object.
   * Use this when you need to call driver-specific APIs not exposed
   * by IConnection.
   */
  getUnderlying(): TRaw;

  /**
   * Releases the connection back to the pool.
   * After calling release(), this connection should not be used again.
   */
  release(): Promise<void>;

  /**
   * Returns true if the connection is still alive and usable.
   */
  isAlive(): boolean;

  /**
   * Timestamp (ms since epoch) when this connection was acquired from the pool.
   * Used by the leak detector to identify connections held too long.
   */
  readonly acquiredAt: number;
}
