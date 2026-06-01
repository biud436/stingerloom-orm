import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Request, Response } from "express";
import { Observable, from, of } from "rxjs";
import { mergeMap, catchError } from "rxjs/operators";
import { createHash } from "node:crypto";
import { EntityManager, sql } from "@stingerloom/orm";
import { IdempotencyKey } from "./idempotency-key.entity";

const HEADER = "idempotency-key";
const KEY_REGEX = /^[a-zA-Z0-9_\-]{1,128}$/;
const TTL_HOURS = 24;
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * How long a freshly-claimed `in_flight` row is considered "owned" by its
 * writer. A retry that arrives within this window while the row is still
 * `in_flight` is treated as a genuinely-concurrent duplicate → 409.
 *
 * Past the window the claim is assumed STALE — the original writer crashed
 * after committing its business transaction but before persisting the result
 * (issue #361). Without a lease such a row would 409 every retry until the 24h
 * TTL sweep. A stale claim is therefore RE-CLAIMABLE: the next caller atomically
 * re-leases it and re-runs the handler.
 *
 * Tunable via `IDEMPOTENCY_LEASE_MS` (default 2 minutes) — long enough to
 * outlast any realistic in-progress handler, short enough that a crash recovers
 * quickly.
 */
const LEASE_MS = (() => {
  const raw = Number(process.env.IDEMPOTENCY_LEASE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 1000;
})();

/**
 * Stripe-style idempotency interceptor.
 *
 * Activates only when the request:
 *   - is POST/PATCH/PUT/DELETE
 *   - carries a non-empty `Idempotency-Key` header (≤ 128 chars,
 *     matching `[a-zA-Z0-9_\-]{1,128}`)
 *
 * Flow:
 *   1. Hash `(method, path, body)` to `requestHash`.
 *   2. INSERT a row with `status="in_flight"` and the request hash. The PK is
 *      the key itself, so the second concurrent caller's INSERT collides on
 *      UNIQUE (PG `23505` / MySQL `ER_DUP_ENTRY`) and we read back the
 *      existing row.
 *   3. If the existing row's `requestHash` differs → 422 IDEMPOTENCY_KEY_COLLISION.
 *      If it's still `in_flight` → 409 IDEMPOTENCY_IN_FLIGHT.
 *      If `completed` → re-emit the stored body with the stored status.
 *   4. On the first writer, run the handler, then UPDATE the row with the
 *      response + status="completed". On error we still UPDATE so the next
 *      replay sees the same failure.
 *
 * `IdempotencyKey` is its own entity so the interceptor can `repo.save()` /
 * `repo.findOne()` instead of hand-rolling SQL. The single dialect-specific
 * piece is the "create or get" insert which has to differ between PG and
 * MySQL — we keep that in one tiny helper.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    if (!MUTATING_METHODS.has(req.method)) return next.handle();

    const headerVal = pickHeader(req);
    if (!headerVal) return next.handle();
    if (!KEY_REGEX.test(headerVal)) {
      throw new HttpException(
        {
          status: HttpStatus.BAD_REQUEST,
          code: "BAD_IDEMPOTENCY_KEY",
          message: "Idempotency-Key must match [a-zA-Z0-9_-]{1,128}",
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const requestHash = hashRequest(req);
    const userId = pickUserId(req);

    return from(this.tryClaim(headerVal, requestHash, userId)).pipe(
      mergeMap((existing) => {
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new HttpException(
              {
                status: HttpStatus.UNPROCESSABLE_ENTITY,
                code: "IDEMPOTENCY_KEY_COLLISION",
                message:
                  "The Idempotency-Key was already used with a different request body or path",
              },
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          if (existing.status === "in_flight") {
            throw new HttpException(
              {
                status: HttpStatus.CONFLICT,
                code: "IDEMPOTENCY_IN_FLIGHT",
                message:
                  "A request with this Idempotency-Key is still being processed",
              },
              HttpStatus.CONFLICT,
            );
          }
          // status === "completed" — replay
          if (existing.httpStatus) res.status(existing.httpStatus);
          return of(existing.response);
        }

        // Newly claimed — run the handler and persist the response. We
        // await `persistResult` *before* the response is emitted so a
        // sequential replay never races the in_flight row out of its
        // post-handler UPDATE.
        //
        // The status we persist is the route's DECLARED status, resolved from
        // the handler metadata — NOT `res.statusCode`. Nest applies the
        // @HttpCode / method-default status in RouterResponseController.apply()
        // AFTER this RxJS pipeline resolves, so reading `res.statusCode` here
        // would always observe the stale default 200 and a 201/204 route would
        // replay as 200 (issue #362).
        // On the first call Nest stamps the status itself (via @HttpCode /
        // method default) — we only need to PERSIST that same status so the
        // later replay (which short-circuits Nest's status logic) can re-emit
        // it. We resolve it the same way Nest will, before the handler runs.
        const declaredStatus = this.resolveDeclaredStatus(ctx, req.method);
        return next.handle().pipe(
          mergeMap(async (body) => {
            await this.persistResult(headerVal, declaredStatus, body);
            return body;
          }),
          catchError(async (err) => {
            const failBody = { error: true, message: (err as Error)?.message };
            await this.persistResult(
              headerVal,
              HttpStatus.INTERNAL_SERVER_ERROR,
              failBody,
            ).catch(() => undefined);
            throw err;
          }),
        );
      }),
    );
  }

  /**
   * Resolve the status the route INTENDS to return, independent of the
   * Express response object (which Nest has not stamped yet at interceptor
   * time). Precedence:
   *   1. An explicit `@HttpCode(n)` on the handler (`HTTP_CODE_METADATA`).
   *   2. Nest's method default — POST → 201, everything else → 200.
   */
  private resolveDeclaredStatus(ctx: ExecutionContext, method: string): number {
    const explicit = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      ctx.getHandler(),
    );
    if (typeof explicit === "number") return explicit;
    return method === "POST" ? HttpStatus.CREATED : HttpStatus.OK;
  }

  /**
   * Try to INSERT a fresh in_flight row. Returns `null` when the caller is the
   * first/owning writer (a fresh row was inserted, OR a STALE in_flight row was
   * atomically re-leased to us), or the existing row if the key is already
   * owned by a live request / completed.
   *
   * We keep this dialect-aware since PG and MySQL differ on the
   * "insert-or-skip" spelling and we need to RETURN the row either way.
   */
  private async tryClaim(
    key: string,
    requestHash: string,
    userId: number | null,
  ): Promise<IdempotencyKey | null> {
    const repo = this.em.getRepository(IdempotencyKey);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_HOURS * 3600 * 1000);
    // Both PG `timestamp` and MySQL `datetime` accept the SQL-style
    // "YYYY-MM-DD HH:mm:ss" form. We write that explicitly because the
    // sql-template-tag binding rejects raw Date values.
    const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const nowSql = fmt(now);
    const expiresSql = fmt(expiresAt);

    const isMysql = this.em.getDriver().isMySqlFamily();
    const I = this.em.ref(IdempotencyKey);

    const insertSql = isMysql
      ? sql`INSERT IGNORE INTO ${I} (${I.key}, ${I.userId}, ${I.requestHash}, ${I.status}, ${I.expiresAt}, ${I.createdAt}) VALUES (${key}, ${userId}, ${requestHash}, ${"in_flight"}, ${expiresSql}, ${nowSql})`
      : sql`INSERT INTO ${I} (${I.key}, ${I.userId}, ${I.requestHash}, ${I.status}, ${I.expiresAt}, ${I.createdAt}) VALUES (${key}, ${userId}, ${requestHash}, ${"in_flight"}, ${expiresSql}::timestamp, ${nowSql}::timestamp) ON CONFLICT (${I.key}) DO NOTHING`;

    const result = await this.em.query<unknown>(insertSql);
    const affected = readAffected(result);
    if (affected === 1) return null;

    // Row already existed — read it back.
    const existing = await repo.findOne({ where: { key } });
    if (!existing) {
      // Race: the row vanished between the failed INSERT and this SELECT
      // (e.g. a concurrent TTL sweep). Treat as "could not claim" — surfaces
      // as a transient 409 the client can retry.
      return existing;
    }

    // A stranded `in_flight` claim (issue #361): the row is still in_flight
    // but its lease has expired, meaning the original writer never reached
    // persistResult. Atomically re-lease it to THIS caller so the handler can
    // re-run instead of 409-ing until the 24h TTL.
    //
    // The UPDATE is the concurrency gate: it matches ONLY a row that is still
    // in_flight AND still older than the lease (created_at < leaseFloor). Two
    // concurrent retries both attempting the re-claim therefore race on the
    // same conditional UPDATE — exactly one bumps created_at past the floor,
    // so only it sees affected === 1 and proceeds; the loser's UPDATE matches
    // nothing and it falls through to the in_flight 409.
    if (existing.status === "in_flight" && this.isStale(existing.createdAt, now)) {
      const leaseFloor = fmt(new Date(now.getTime() - LEASE_MS));
      const reclaimSql = isMysql
        ? sql`UPDATE ${I} SET ${I.createdAt} = ${nowSql}, ${I.requestHash} = ${requestHash}, ${I.userId} = ${userId} WHERE ${I.key} = ${key} AND ${I.status} = ${"in_flight"} AND ${I.createdAt} < ${leaseFloor}`
        : sql`UPDATE ${I} SET ${I.createdAt} = ${nowSql}::timestamp, ${I.requestHash} = ${requestHash}, ${I.userId} = ${userId} WHERE ${I.key} = ${key} AND ${I.status} = ${"in_flight"} AND ${I.createdAt} < ${leaseFloor}::timestamp`;
      const reclaimResult = await this.em.query<unknown>(reclaimSql);
      if (readAffected(reclaimResult) === 1) {
        // We won the re-lease — act as the owning writer.
        return null;
      }
      // Lost the race to a concurrent re-claimer; re-read so the caller sees
      // the live state (fresh in_flight → 409, or completed → replay).
      return repo.findOne({ where: { key } });
    }

    return existing;
  }

  /**
   * A claim is stale when its `createdAt` is older than the lease window. A
   * missing/unparseable timestamp is treated as stale (fail-open toward
   * recovery) so a malformed row can never strand a key forever.
   */
  private isStale(createdAt: Date | string | null, now: Date): boolean {
    if (createdAt == null) return true;
    const created =
      createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
    if (!Number.isFinite(created)) return true;
    return now.getTime() - created >= LEASE_MS;
  }

  private async persistResult(
    key: string,
    httpStatus: number,
    response: unknown,
  ): Promise<void> {
    // The row was just INSERTed by tryClaim — use UPDATE rather than
    // repo.save() because save() on an entity with @PrimaryColumn (manual
    // PK) always falls through to INSERT and trips ER_DUP_ENTRY here.
    const I = this.em.ref(IdempotencyKey);
    const responseJson =
      response === undefined || response === null
        ? null
        : JSON.stringify(response);
    await this.em.query(sql`
      UPDATE ${I}
         SET ${I.status} = ${"completed"},
             ${I.httpStatus} = ${httpStatus},
             ${I.response} = ${responseJson}
       WHERE ${I.key} = ${key}
    `);
  }
}

function pickHeader(req: Request): string | null {
  const v = req.header("Idempotency-Key") ?? req.header(HEADER);
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function hashRequest(req: Request): string {
  // The hash anchors on (method, path, body). Header set is excluded on
  // purpose: clients legitimately retry with refreshed auth tokens or
  // tracing IDs. URL query string IS part of `req.path`'s sibling
  // `req.originalUrl` so include the URL explicitly.
  const url = (req as Request & { originalUrl?: string }).originalUrl ?? req.url;
  const body = stableStringify(req.body);
  return createHash("sha256")
    .update(`${req.method}\n${url}\n${body}`)
    .digest("hex")
    .slice(0, 64);
}

function pickUserId(req: Request): number | null {
  const u = (req as Request & { user?: { id?: number } }).user;
  return typeof u?.id === "number" ? u.id : null;
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * Read the affected-rows count from whatever shape `em.query()` returned for
 * the dialect. The mysql2 driver returns `{ affectedRows }`, pg returns
 * `{ rowCount }`, and Stingerloom may unwrap it to a plain `[rows, ...]`
 * array. When in doubt, treat "no metadata" as "row was inserted" — the
 * subsequent SELECT will sort it out.
 */
function readAffected(result: unknown): number {
  const r = result as
    | { affectedRows?: number; rowCount?: number; affected?: number }
    | unknown[]
    | null
    | undefined;
  if (r == null) return 0;
  if (Array.isArray(r)) return 1;
  if (typeof r === "object") {
    const obj = r as { affectedRows?: number; rowCount?: number; affected?: number };
    return obj.affectedRows ?? obj.rowCount ?? obj.affected ?? 0;
  }
  return 0;
}
