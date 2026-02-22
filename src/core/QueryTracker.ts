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
 * N+1 쿼리 감지 및 슬로우 쿼리 경고를 위한 쿼리 추적기입니다.
 *
 * 동일 엔티티에 대해 짧은 시간(windowMs) 내 threshold 이상의 쿼리가 실행되면
 * N+1 경고를 발행합니다.
 */
export class QueryTracker {
  private readonly log: QueryLogEntry[] = [];
  private readonly logger = new Logger("QueryTracker");

  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly slowQueryMs: number | null;
  private readonly warned = new Set<string>();

  constructor(options?: {
    windowMs?: number;
    threshold?: number;
    slowQueryMs?: number | null;
  }) {
    this.windowMs = options?.windowMs ?? 100;
    this.threshold = options?.threshold ?? 10;
    this.slowQueryMs = options?.slowQueryMs ?? null;
  }

  /**
   * 쿼리 실행 기록을 추가하고 N+1 / 슬로우 쿼리 감지를 수행합니다.
   */
  track(entityName: string, sqlText: string, durationMs: number): void {
    const now = Date.now();

    this.log.push({
      entityName,
      sql: sqlText,
      durationMs,
      timestamp: now,
    });

    // 슬로우 쿼리 감지
    if (this.slowQueryMs !== null && durationMs > this.slowQueryMs) {
      this.logger.warn(
        `[SLOW QUERY] ${durationMs}ms: ${sqlText}`,
      );
    }

    // N+1 감지: windowMs 이내의 동일 엔티티 쿼리 수 카운트
    this.detectNPlusOne(entityName, now);
  }

  /**
   * 전체 쿼리 로그를 반환합니다.
   */
  getLog(): ReadonlyArray<QueryLogEntry> {
    return this.log;
  }

  /**
   * 쿼리 로그와 경고 이력을 초기화합니다.
   */
  reset(): void {
    this.log.length = 0;
    this.warned.clear();
  }

  private detectNPlusOne(entityName: string, now: number): void {
    // 이미 이 엔티티에 대해 경고를 발행했으면 중복 경고 방지
    if (this.warned.has(entityName)) return;

    const windowStart = now - this.windowMs;
    let count = 0;

    // 최근 로그를 뒤에서부터 탐색 (최신 항목이 끝에 있으므로)
    for (let i = this.log.length - 1; i >= 0; i--) {
      const entry = this.log[i];
      if (entry.timestamp < windowStart) break;
      if (entry.entityName === entityName) {
        count++;
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
