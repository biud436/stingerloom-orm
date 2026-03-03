import { Logger } from "../utils/Logger";
import { IConnection } from "./IConnection";

/**
 * Connection pool metrics snapshot.
 */
export interface PoolMetrics {
  /** Number of connections currently checked out from the pool. */
  active: number;
  /** Number of idle connections available in the pool. */
  idle: number;
  /** Number of callers waiting for a connection. */
  pending: number;
}

/**
 * Tracks acquired connections and detects leaks when connections are held
 * longer than the configured threshold.
 *
 * Usage:
 *   const detector = new ConnectionLeakDetector(30_000);
 *   const conn = await pool.getConnection();
 *   const tracked = detector.track(conn);
 *   // ... use tracked (it implements IConnection) ...
 *   await tracked.release(); // automatically unregisters from detector
 */
export class ConnectionLeakDetector {
  private readonly tracked = new Set<IConnection>();
  private readonly logger = new Logger("ConnectionLeakDetector");
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param thresholdMs Connections held longer than this are flagged as potential leaks.
   *                    Set to 0 to disable leak detection.
   * @param checkIntervalMs How often (ms) to scan for leaked connections.
   *                        Defaults to thresholdMs / 2 (minimum 5000ms).
   */
  constructor(
    private readonly thresholdMs: number,
    checkIntervalMs?: number,
  ) {
    if (thresholdMs > 0) {
      const interval = checkIntervalMs ?? Math.max(thresholdMs / 2, 5000);
      this.timer = setInterval(() => this.checkLeaks(), interval);
      // Allow the process to exit even if the timer is running
      if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
        this.timer.unref();
      }
    }
  }

  /**
   * Register a connection for leak tracking.
   * Returns the same connection (no wrapping needed since IConnection
   * already carries acquiredAt).
   */
  track<T>(connection: IConnection<T>): IConnection<T> {
    this.tracked.add(connection);
    return connection;
  }

  /**
   * Unregister a connection (called automatically on release).
   */
  untrack(connection: IConnection): void {
    this.tracked.delete(connection);
  }

  /**
   * Scan all tracked connections and warn about potential leaks.
   */
  checkLeaks(): void {
    if (this.thresholdMs <= 0) return;

    const now = Date.now();
    for (const conn of this.tracked) {
      const held = now - conn.acquiredAt;
      if (held > this.thresholdMs) {
        this.logger.warn(
          `Potential connection leak detected: connection held for ${held}ms ` +
            `(threshold: ${this.thresholdMs}ms). Consider releasing it.`,
        );
      }
    }
  }

  /**
   * Returns the number of currently tracked (active) connections.
   */
  get activeCount(): number {
    return this.tracked.size;
  }

  /**
   * Stops the background leak-check timer and clears all tracked connections.
   */
  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tracked.clear();
  }
}
