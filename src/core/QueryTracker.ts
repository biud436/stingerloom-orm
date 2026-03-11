import { Logger } from "../utils/Logger";

/**
 * 개별 쿼리 실행 기록.
 */
export interface QueryLogEntry {
  entityName: string;
  sql: string;
  durationMs: number;
  timestamp: number;
}

/**
 * QueryTracker 생성 옵션.
 */
export interface QueryTrackerOptions {
  /** N+1 감지 윈도우 (ms). @default 100 */
  windowMs?: number;

  /** N+1 감지 임계값. @default 10 */
  threshold?: number;

  /** 이 값(ms)을 초과하는 쿼리에 슬로우 쿼리 경고 출력. null이면 비활성. @default null */
  slowQueryMs?: number | null;

  /**
   * 최대 로그 보관 수. 순환 버퍼 방식으로 초과 시 가장 오래된 항목부터 제거됩니다.
   * 0 또는 Infinity이면 무제한.
   * @default 1000
   */
  maxLogEntries?: number;

  /**
   * QueryTracker 활성화 여부. false이면 track()이 아무 작업도 하지 않습니다.
   * 프로덕션 환경에서 오버헤드를 제거하려면 false로 설정하세요.
   * @default true
   */
  enabled?: boolean;

  /**
   * 로그 항목 자동 삭제 TTL (ms). 설정 시 track() 호출마다 이 시간보다 오래된 항목을 제거합니다.
   * 0 또는 undefined이면 TTL 비활성.
   * @default undefined
   */
  ttlMs?: number;
}

/**
 * N+1 쿼리 감지 및 슬로우 쿼리 경고를 위한 쿼리 추적기입니다.
 *
 * 동일 엔티티에 대해 짧은 시간(windowMs) 내 threshold 이상의 쿼리가 실행되면
 * N+1 경고를 발행합니다.
 *
 * O(1) 삽입의 순환 버퍼로 maxLogEntries를 초과하면 가장 오래된 항목부터 제거합니다.
 * enabled=false로 프로덕션에서 오버헤드를 완전히 제거할 수 있습니다.
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

  /** 현재 실행 중인 쿼리 수 (graceful shutdown 대기용). */
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
   * 쿼리 실행 기록을 추가하고 N+1 / 슬로우 쿼리 감지를 수행합니다.
   * enabled=false이면 아무 작업도 하지 않습니다.
   */
  track(entityName: string, sqlText: string, durationMs: number): void {
    if (!this.enabled) return;

    const now = Date.now();

    // TTL 기반 자동 정리
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

    // 슬로우 쿼리 감지
    if (this.slowQueryMs !== null && durationMs > this.slowQueryMs) {
      this.logger.warn(`[SLOW QUERY] ${durationMs}ms: ${sqlText}`);
    }

    // N+1 감지: windowMs 이내의 동일 엔티티 쿼리 수 카운트
    this.detectNPlusOne(entityName, now);
  }

  /**
   * 전체 쿼리 로그를 반환합니다 (시간순, 가장 오래된 항목이 앞).
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
   * 현재 실행 중인 쿼리 수를 반환합니다.
   */
  get activeQueryCount(): number {
    return this._activeQueryCount;
  }

  /**
   * 쿼리 실행 시작을 기록합니다. (활성 쿼리 카운터 증가)
   */
  beginQuery(): void {
    this._activeQueryCount++;
  }

  /**
   * 쿼리 실행 완료를 기록합니다. (활성 쿼리 카운터 감소)
   */
  endQuery(): void {
    if (this._activeQueryCount > 0) {
      this._activeQueryCount--;
    }
  }

  /**
   * 모든 활성 쿼리가 완료될 때까지 대기합니다.
   * @param timeoutMs 최대 대기 시간 (ms). 초과 시 resolve됩니다.
   * @returns 모든 쿼리가 완료되면 true, 타임아웃이면 false.
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
   * 쿼리 로그와 경고 이력을 초기화합니다.
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
   * TTL보다 오래된 로그 항목을 제거합니다. O(k) — k = 제거 대상 수.
   */
  private evictExpired(now: number): void {
    const cutoff = now - this.ttlMs;
    if (this.unbounded) {
      let removeCount = 0;
      for (let i = 0; i < this.unboundedLog.length; i++) {
        if (this.unboundedLog[i].timestamp < cutoff) {
          removeCount++;
        } else {
          break; // 시간순이므로 첫 유효 항목에서 중단
        }
      }
      if (removeCount > 0) {
        this.unboundedLog.splice(0, removeCount);
      }
    } else {
      // Circular buffer: head 포인터만 전진 — O(k)
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
    // 이미 이 엔티티에 대해 경고를 발행했으면 중복 경고 방지
    if (this.warned.has(entityName)) return;

    const windowStart = now - this.windowMs;
    let count = 0;

    if (this.unbounded) {
      // 최근 로그를 뒤에서부터 탐색
      for (let i = this.unboundedLog.length - 1; i >= 0; i--) {
        const entry = this.unboundedLog[i];
        if (entry.timestamp < windowStart) break;
        if (entry.entityName === entityName) count++;
      }
    } else {
      // 순환 버퍼: 뒤에서부터 탐색
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
