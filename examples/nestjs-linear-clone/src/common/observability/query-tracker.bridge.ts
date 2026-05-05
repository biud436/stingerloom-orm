import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EntityManager, QueryLogEntry } from "@stingerloom/orm";
import { PinoLogger, InjectPinoLogger } from "nestjs-pino";
import { RequestContextStore } from "../context/request-context";

/**
 * Subscribes to Stingerloom QueryTracker events and re-emits them as
 * structured pino log lines so slow queries and N+1 detections show up in
 * the same log stream as HTTP access lines, correlated by `requestId`.
 *
 * QueryTracker fires inside the AsyncLocalStorage frame opened by
 * RequestContextMiddleware, so the requestId is read from there at emit
 * time — no need to thread it through.
 */
@Injectable()
export class QueryTrackerBridge implements OnModuleInit, OnModuleDestroy {
  private readonly slowQueryHandler = (entry: QueryLogEntry) => {
    const ctx = RequestContextStore.get();
    this.logger.warn(
      {
        event: "db.slow_query",
        requestId: ctx?.requestId,
        userId: ctx?.userId,
        workspaceId: ctx?.workspaceId,
        entity: entry.entityName,
        durationMs: entry.durationMs,
        sql: entry.sql,
      },
      `slow query ${entry.durationMs}ms on ${entry.entityName}`,
    );
  };

  private readonly nPlusOneHandler = (
    entityName: string,
    samples: QueryLogEntry[],
  ) => {
    const ctx = RequestContextStore.get();
    this.logger.warn(
      {
        event: "db.n_plus_one",
        requestId: ctx?.requestId,
        userId: ctx?.userId,
        workspaceId: ctx?.workspaceId,
        entity: entityName,
        sampleCount: samples.length,
        sampleSql: samples.slice(0, 3).map((s) => s.sql),
      },
      `N+1 detected on ${entityName} (${samples.length} queries)`,
    );
  };

  constructor(
    @InjectPinoLogger(QueryTrackerBridge.name)
    private readonly logger: PinoLogger,
    private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    const tracker = this.em.getQueryTracker();
    if (!tracker) {
      this.logger.info(
        "QueryTracker is disabled — set logging.nPlusOne or logging.slowQueryMs to enable",
      );
      return;
    }
    tracker.on("slowQuery", this.slowQueryHandler);
    tracker.on("nPlusOne", this.nPlusOneHandler);
  }

  onModuleDestroy(): void {
    const tracker = this.em.getQueryTracker();
    if (!tracker) return;
    tracker.off("slowQuery", this.slowQueryHandler);
    tracker.off("nPlusOne", this.nPlusOneHandler);
  }
}
