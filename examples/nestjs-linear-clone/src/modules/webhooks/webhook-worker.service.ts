import { Injectable, Inject, Logger } from "@nestjs/common";
import { createHmac } from "node:crypto";
import {
  BaseRepository,
  EntityManager,
  Expressions as exp,
  Transactional,
  qAlias,
  sql,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { WebhookDelivery } from "./webhook-delivery.entity";
import { WebhookEndpoint } from "./webhook-endpoint.entity";
import { assertSafeWebhookUrl } from "./ssrf-guard";

const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 5_000;
const SENTINEL_TIMEOUT_SECONDS = 30;
const SENTINEL_PREFIX = "__claim:";

/**
 * Lease window for a claimed (`in_flight`) delivery. A worker that claims a row
 * has this long to drive it to `delivered`/`failed` before the reaper assumes
 * the worker crashed and re-queues the row. Sized comfortably above the
 * per-request timeout so a slow-but-alive delivery is never reaped mid-flight.
 */
const LEASE_TIMEOUT_SECONDS = 60;

/**
 * Hard cap on how many times the reaper will rescue the same row from a crashed
 * worker. Past this, a perpetually-stranded ("poison") row is parked in
 * `failed` rather than being reclaimed forever.
 */
const MAX_RECLAIMS = MAX_ATTEMPTS;

export interface TickResult {
  claimed: number;
  delivered: number;
  failed: number;
  permanentlyFailed: number;
  /** in_flight rows re-queued to pending after their lease expired. */
  reclaimed: number;
  /** stranded rows that hit the reclaim cap and were parked in `failed`. */
  reclaimFailed: number;
}

/**
 * Out-of-band delivery worker for the webhook outbox.
 *
 * Claim strategy is dialect-aware (mirrors `QueueService`):
 *
 * - PostgreSQL — `forUpdateSkipLocked()` + UPDATE within the same tx.
 * - MySQL/MariaDB — sentinel-tagged `UPDATE … LIMIT 1` because
 *   `SELECT … FOR UPDATE SKIP LOCKED` returns empty under contention on
 *   MariaDB 11.x's filesort path. The sentinel lives in `last_error` for the
 *   few ms between claim and promotion, and a sentinel cutoff reclaims rows
 *   from workers that crashed mid-claim.
 *
 * The worker polls `pending` rows whose `next_attempt_at <= NOW()`, flips
 * them to `in_flight`, releases the lock, POSTs the payload, and either marks
 * `delivered` on 2xx or reschedules with exponential backoff. After
 * `MAX_ATTEMPTS` failures the row is parked in `failed` for manual inspection.
 */
@Injectable()
export class WebhookDeliveryWorker {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);

  constructor(
    @InjectRepository(WebhookDelivery)
    private readonly deliveries: BaseRepository<WebhookDelivery>,
    @InjectRepository(WebhookEndpoint)
    private readonly endpoints: BaseRepository<WebhookEndpoint>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  async tick(batchSize = 16): Promise<TickResult> {
    // Reap first: re-queue rows whose lease expired (worker crashed mid-flight)
    // so they become claimable again in this very tick.
    const { reclaimed, reclaimFailed } = await this.reapStale(batchSize);

    const claimed = await this.claimBatch(batchSize);
    let delivered = 0;
    let failed = 0;
    let permanentlyFailed = 0;

    for (const id of claimed) {
      const outcome = await this.deliverOne(id);
      if (outcome === "delivered") delivered++;
      else if (outcome === "failed-permanent") permanentlyFailed++;
      else failed++;
    }

    return {
      claimed: claimed.length,
      delivered,
      failed,
      permanentlyFailed,
      reclaimed,
      reclaimFailed,
    };
  }

  // ── reaper ─────────────────────────────────────────────

  /**
   * Lease-based reaper for stranded `in_flight` rows.
   *
   * A delivery is flipped to `in_flight` at claim time and only leaves that
   * state when `deliverOne` marks it delivered/failed. If the worker process
   * dies in between, the row is orphaned forever. This step finds `in_flight`
   * rows whose `last_attempted_at` (the claim timestamp) is older than the
   * lease window and, treating the dead claim as a failed attempt:
   *
   *   - re-queues them to `pending` for immediate re-claim (the expired lease
   *     already served as the wait), OR
   *   - parks them in `failed` once they have been reclaimed `MAX_RECLAIMS`
   *     times, so a poison row that strands every worker eventually terminates
   *     instead of looping.
   *
   * Reclaim is dialect-agnostic: it operates purely on `state`/`last_attempted_at`
   * and works identically on the Postgres and MySQL claim paths.
   */
  @Transactional()
  private async reapStale(
    batchSize: number,
  ): Promise<{ reclaimed: number; reclaimFailed: number }> {
    const d = qAlias(WebhookDelivery, "d");
    const leaseCutoff = exp
      .currentTimestamp()
      .addSeconds(-LEASE_TIMEOUT_SECONDS);

    const stale = await this.deliveries
      .createQueryBuilder(d)
      .where(d.state.eq("in_flight"))
      .andWhere(d.lastAttemptedAt.lt(leaseCutoff))
      .orderBy(d.lastAttemptedAt.asc())
      .limit(batchSize)
      .getMany();

    let reclaimed = 0;
    let reclaimFailed = 0;
    const now = new Date();

    for (const row of stale) {
      // The lost claim counts as a spent attempt.
      const attemptCount = row.attemptCount + 1;
      if (attemptCount >= MAX_RECLAIMS) {
        await this.deliveries.updateMany(
          {
            state: "failed",
            attemptCount,
            lastAttemptedAt: now,
            nextAttemptAt: null,
            lastError: "lease expired (worker crashed) — reclaim cap reached",
          },
          { where: { id: row.id } },
        );
        reclaimFailed++;
      } else {
        await this.deliveries.updateMany(
          {
            state: "pending",
            attemptCount,
            lastAttemptedAt: now,
            // Re-queue for immediate claim: the expired lease already served as
            // the wait, so a crashed-worker reclaim retries promptly rather than
            // sitting out a fresh exponential backoff (which is for app-level
            // failures via markFailed, not lost claims).
            nextAttemptAt: now,
            lastError: "lease expired (worker crashed) — re-queued",
          },
          { where: { id: row.id } },
        );
        reclaimed++;
      }
    }

    return { reclaimed, reclaimFailed };
  }

  // ── claim ──────────────────────────────────────────────

  @Transactional()
  private async claimBatch(batchSize: number): Promise<number[]> {
    return this.em.getDriver().isMySqlFamily()
      ? this.claimMysql(batchSize)
      : this.claimPostgres(batchSize);
  }

  private async claimPostgres(batchSize: number): Promise<number[]> {
    const d = qAlias(WebhookDelivery, "d");
    const candidates = await this.deliveries
      .createQueryBuilder(d)
      .where(d.state.eq("pending"))
      .andWhere(d.nextAttemptAt.lte(exp.currentTimestamp()))
      .orderBy(d.nextAttemptAt.asc())
      .limit(batchSize)
      .forUpdateSkipLocked()
      .getMany();

    const ids = candidates.map((c) => c.id);
    if (ids.length === 0) return [];

    for (const id of ids) {
      await this.deliveries.updateMany(
        { state: "in_flight", lastAttemptedAt: new Date() },
        { where: { id } },
      );
    }
    return ids;
  }

  /**
   * MySQL/MariaDB sentinel-tag claim: tag a batch with a unique sentinel into
   * `last_error`, then read back the tagged ids. The sentinel cutoff also
   * reclaims rows whose worker crashed between tag and promote.
   */
  private async claimMysql(batchSize: number): Promise<number[]> {
    const sentinel = `${SENTINEL_PREFIX}${process.pid}-${Date.now()}-${Math.floor(
      Math.random() * 1e9,
    )}`;
    const sentinelCutoff = exp
      .currentTimestamp()
      .addSeconds(-SENTINEL_TIMEOUT_SECONDS);
    const d = qAlias(WebhookDelivery, "d");

    const { affected } = await this.deliveries
      .createUpdateBuilder(d)
      .set({ lastError: sentinel, lastAttemptedAt: new Date() })
      .where(
        exp.or(
          exp.and(
            d.state.eq("pending"),
            d.nextAttemptAt.lte(exp.currentTimestamp()),
          ),
          exp.and(
            d.lastError.like(`${SENTINEL_PREFIX}%`),
            d.lastAttemptedAt.lt(sentinelCutoff),
          ),
        ),
      )
      .orderBy(d.nextAttemptAt.asc())
      .limit(batchSize)
      .execute();
    if (affected === 0) return [];

    const tagged = await this.deliveries
      .createQueryBuilder(d)
      .where(d.lastError.eq(sentinel))
      .limit(batchSize)
      .getMany();

    if (tagged.length === 0) return [];

    const ids = tagged.map((t) => t.id);
    for (const id of ids) {
      await this.deliveries.updateMany(
        { state: "in_flight", lastError: null },
        { where: { id } },
      );
    }
    return ids;
  }

  // ── deliver ────────────────────────────────────────────

  private async deliverOne(
    deliveryId: number,
  ): Promise<"delivered" | "failed-retry" | "failed-permanent"> {
    const d = await this.deliveries.findOne({ where: { id: deliveryId } });
    if (!d) return "failed-permanent";

    const ep = await this.endpoints.findOne({
      where: { id: d.endpointId! },
    });
    if (!ep) {
      await this.markFailed(d, "endpoint deleted", true);
      return "failed-permanent";
    }

    const body = JSON.stringify({ event: d.eventType, payload: d.payload });
    const signature = createHmac("sha256", ep.secret).update(body).digest("hex");

    // DNS-rebind defense: re-resolve and range-check the endpoint host
    // immediately before the request. A URL that passed validation at write
    // time could now resolve to a private/loopback IP; refuse to fetch it.
    // A blocked endpoint is treated as a permanent failure (it will never be
    // safely deliverable until the operator changes the URL).
    try {
      await assertSafeWebhookUrl(ep.url);
    } catch (err) {
      const reason = `blocked by SSRF guard: ${(err as Error)?.message ?? "unsafe URL"}`;
      await this.markFailed(d, reason, true);
      return "failed-permanent";
    }

    let ok = false;
    let errMessage: string | null = null;
    try {
      const res = await fetchWithTimeout(
        ep.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "X-Webhook-Event": d.eventType,
            "X-Webhook-Delivery-Id": String(d.id),
          },
          body,
        },
        REQUEST_TIMEOUT_MS,
      );
      ok = res.status >= 200 && res.status < 300;
      if (!ok) errMessage = `HTTP ${res.status}`;
    } catch (err) {
      errMessage = (err as Error)?.message ?? "fetch failed";
    }

    if (ok) {
      await this.markDelivered(d);
      return "delivered";
    }
    const exhausted = d.attemptCount + 1 >= MAX_ATTEMPTS;
    await this.markFailed(d, errMessage ?? "unknown", exhausted);
    return exhausted ? "failed-permanent" : "failed-retry";
  }

  @Transactional()
  private async markDelivered(d: WebhookDelivery): Promise<void> {
    d.state = "delivered";
    d.attemptCount = d.attemptCount + 1;
    d.lastAttemptedAt = new Date();
    d.lastError = null;
    d.nextAttemptAt = null;
    await this.deliveries.save(d);
  }

  @Transactional()
  private async markFailed(
    d: WebhookDelivery,
    reason: string,
    permanent: boolean,
  ): Promise<void> {
    d.attemptCount = d.attemptCount + 1;
    d.lastAttemptedAt = new Date();
    d.lastError = reason.slice(0, 1000);
    if (permanent) {
      d.state = "failed";
      d.nextAttemptAt = null;
    } else {
      d.state = "pending";
      d.nextAttemptAt = backoffDate(d.attemptCount);
    }
    await this.deliveries.save(d);
  }
}

/** 2^n * 30s exponential backoff. attempt 1 → 60s, 2 → 120s, 3 → 240s, … */
function backoffDate(attempt: number): Date {
  const seconds = Math.pow(2, attempt) * 30;
  return new Date(Date.now() + seconds * 1000);
}

async function fetchWithTimeout(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs: number,
): Promise<{ status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}
