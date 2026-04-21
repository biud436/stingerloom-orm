import { Logger } from "../utils/Logger";

/**
 * A single query execution record.
 */
export interface QueryLogEntry {
  entityName: string;
  sql: string;
  durationMs: number;
  timestamp: number;
}

/**
 * Options for creating a QueryTracker.
 */
export interface QueryTrackerOptions {
  /** N+1 detection window in milliseconds. @default 100 */
  windowMs?: number;

  /** N+1 detection threshold. @default 10 */
  threshold?: number;

  /** Emits a slow-query warning for queries exceeding this threshold (ms). null disables. @default null */
  slowQueryMs?: number | null;

  /**
   * Maximum log entries retained. Uses a circular buffer; older entries are evicted first on overflow.
   * 0 or Infinity means unbounded.
   * @default 1000
   */
  maxLogEntries?: number;

  /**
   * Whether QueryTracker is enabled. When false, track() is a no-op.
   * Set to false in production to eliminate overhead.
   * @default true
   */
  enabled?: boolean;

  /**
   * Automatic log-eviction TTL (ms). When set, entries older than this are removed on each track() call.
   * 0 or undefined disables TTL.
   * @default undefined
   */
  ttlMs?: number;
}

/**
 * Query tracker for N+1 detection and slow-query warnings.
 *
 * Emits an N+1 warning when the same entity is queried at least `threshold`
 * times within the `windowMs` window.
 *
 * Uses a circular buffer with O(1) inserts; once maxLogEntries is exceeded,
 * the oldest entries are evicted first. Set enabled=false to eliminate
 * overhead entirely in production.
 */
export class QueryTracker {
  // --- Bounded mode: circular buffer (O(1) insert) ---
  private buffer: (QueryLogEntry | undefined)[] = [];
  private head = 0;
  private _size = 0;

  // --- Unbounded mode (maxLogEntries=0 or Infinity): plain array ---
  private readonly unboundedLog: QueryLogEntry[] = [];
  private readonly unbounded: boolean;

  private readonly logger = new Logger("QueryTracker");

  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly slowQueryMs: number | null;
  private readonly maxLogEntries: number;
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly warned = new Set<string>();

  /** Number of in-flight queries (used to wait during graceful shutdown). */
  private _activeQueryCount = 0;

  constructor(options?: QueryTrackerOptions) {
    this.windowMs = options?.windowMs ?? 100;
    this.threshold = options?.threshold ?? 10;
    this.slowQueryMs = options?.slowQueryMs ?? null;
    this.maxLogEntries = options?.maxLogEntries ?? 1000;
    this.enabled = options?.enabled ?? true;
    this.ttlMs = options?.ttlMs ?? 0;
    this.unbounded =
      this.maxLogEntries <= 0 || !isFinite(this.maxLogEntries);
    if (!this.unbounded) {
      this.buffer = new Array(this.maxLogEntries);
    }
  }

  /**
   * Records a query execution and runs N+1 / slow-query detection.
   * When enabled=false, this is a no-op.
   */
  track(entityName: string, sqlText: string, durationMs: number): void {
    if (!this.enabled) return;

    const now = Date.now();

    // TTL-based eviction
    if (this.ttlMs > 0) {
      this.evictExpired(now);
    }

    const entry: QueryLogEntry = {
      entityName,
      sql: sqlText,
      durationMs,
      timestamp: now,
    };

    if (this.unbounded) {
      this.unboundedLog.push(entry);
    } else {
      // O(1) circular buffer insertion
      const writeIdx = (this.head + this._size) % this.maxLogEntries;
      this.buffer[writeIdx] = entry;
      if (this._size < this.maxLogEntries) {
        this._size++;
      } else {
        this.head = (this.head + 1) % this.maxLogEntries;
      }
    }

    // Slow-query detection
    if (this.slowQueryMs !== null && durationMs > this.slowQueryMs) {
      this.logger.warn(`[SLOW QUERY] ${durationMs}ms: ${sqlText}`);
    }

    // N+1 detection: count queries for the same entity within windowMs
    this.detectNPlusOne(entityName, now);
  }

  /**
   * Return the full query log (chronological, oldest first).
   */
  getLog(): ReadonlyArray<QueryLogEntry> {
    if (this.unbounded) return this.unboundedLog;
    const result: QueryLogEntry[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(
        this.buffer[(this.head + i) % this.maxLogEntries]!,
      );
    }
    return result;
  }

  /**
   * Return the number of queries currently in flight.
   */
  get activeQueryCount(): number {
    return this._activeQueryCount;
  }

  /**
   * Record the start of a query (increments the active-query counter).
   */
  beginQuery(): void {
    this._activeQueryCount++;
  }

  /**
   * Record the completion of a query (decrements the active-query counter).
   */
  endQuery(): void {
    if (this._activeQueryCount > 0) {
      this._activeQueryCount--;
    }
  }

  /**
   * Wait until every in-flight query completes.
   * @param timeoutMs maximum wait in milliseconds; resolves when exceeded.
   * @returns true when all queries finish, false on timeout.
   */
  async waitForQueries(timeoutMs: number): Promise<boolean> {
    if (this._activeQueryCount === 0) return true;

    const start = Date.now();
    return new Promise<boolean>((resolve) => {
      const check = () => {
        if (this._activeQueryCount === 0) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * Reset the query log and warning history.
   */
  reset(): void {
    if (this.unbounded) {
      this.unboundedLog.length = 0;
    } else {
      this.head = 0;
      this._size = 0;
    }
    this.warned.clear();
  }

  /**
   * Evict log entries older than TTL. O(k) where k = entries evicted.
   */
  private evictExpired(now: number): void {
    const cutoff = now - this.ttlMs;
    if (this.unbounded) {
      let removeCount = 0;
      for (let i = 0; i < this.unboundedLog.length; i++) {
        if (this.unboundedLog[i].timestamp < cutoff) {
          removeCount++;
        } else {
          break; // Entries are chronological, so stop at the first valid one
        }
      }
      if (removeCount > 0) {
        this.unboundedLog.splice(0, removeCount);
      }
    } else {
      // Circular buffer: only advance the head pointer — O(k)
      while (this._size > 0) {
        const entry = this.buffer[this.head];
        if (entry && entry.timestamp < cutoff) {
          this.head = (this.head + 1) % this.maxLogEntries;
          this._size--;
        } else {
          break;
        }
      }
    }
  }

  private detectNPlusOne(entityName: string, now: number): void {
    // Suppress duplicates: skip if a warning has already been emitted for this entity
    if (this.warned.has(entityName)) return;

    const windowStart = now - this.windowMs;
    let count = 0;

    if (this.unbounded) {
      // Scan recent entries from the back
      for (let i = this.unboundedLog.length - 1; i >= 0; i--) {
        const entry = this.unboundedLog[i];
        if (entry.timestamp < windowStart) break;
        if (entry.entityName === entityName) count++;
      }
    } else {
      // Circular buffer: scan from the back
      for (let i = this._size - 1; i >= 0; i--) {
        const entry = this.buffer[(this.head + i) % this.maxLogEntries]!;
        if (entry.timestamp < windowStart) break;
        if (entry.entityName === entityName) count++;
      }
    }

    if (count >= this.threshold) {
      this.logger.warn(
        `[N+1 WARNING] Entity "${entityName}" queried ${count}+ times in ${this.windowMs}ms. Consider using eager loading or relations option.`,
      );
      this.warned.add(entityName);
    }
  }
}
