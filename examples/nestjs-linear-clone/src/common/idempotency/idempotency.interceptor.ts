import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Observable, from, of } from "rxjs";
import { mergeMap, catchError } from "rxjs/operators";
import { createHash } from "node:crypto";
import { EntityManager, raw, sql } from "@stingerloom/orm";
import { IdempotencyKey } from "./idempotency-key.entity";

const HEADER = "idempotency-key";
const KEY_REGEX = /^[a-zA-Z0-9_\-]{1,128}$/;
const TTL_HOURS = 24;
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

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
        return next.handle().pipe(
          mergeMap(async (body) => {
            const status = res.statusCode || HttpStatus.OK;
            await this.persistResult(headerVal, status, body);
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
   * Try to INSERT a fresh in_flight row. Returns `null` when the row was
   * inserted (caller is the first writer), or the existing row if the key
   * already exists.
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
    const wrap = (n: string) => this.em.wrap(n);
    const tbl = wrap("idempotency_key");
    const cKey = wrap("key");
    const cUserId = wrap("user_id");
    const cReqHash = wrap("request_hash");
    const cStatus = wrap("status");
    const cExpires = wrap("expires_at");
    const cCreated = wrap("created_at");

    const insertSql = isMysql
      ? sql`INSERT IGNORE INTO ${raw(tbl)} (${raw(cKey)}, ${raw(cUserId)}, ${raw(cReqHash)}, ${raw(cStatus)}, ${raw(cExpires)}, ${raw(cCreated)}) VALUES (${key}, ${userId}, ${requestHash}, ${"in_flight"}, ${expiresSql}, ${nowSql})`
      : sql`INSERT INTO ${raw(tbl)} (${raw(cKey)}, ${raw(cUserId)}, ${raw(cReqHash)}, ${raw(cStatus)}, ${raw(cExpires)}, ${raw(cCreated)}) VALUES (${key}, ${userId}, ${requestHash}, ${"in_flight"}, ${expiresSql}::timestamp, ${nowSql}::timestamp) ON CONFLICT (${raw(cKey)}) DO NOTHING`;

    const result = await this.em.query<unknown>(insertSql);
    const affected = readAffected(result);
    if (affected === 1) return null;

    // Row already existed — read it back.
    return repo.findOne({ where: { key } });
  }

  private async persistResult(
    key: string,
    httpStatus: number,
    response: unknown,
  ): Promise<void> {
    // The row was just INSERTed by tryClaim — use UPDATE rather than
    // repo.save() because save() on an entity with @PrimaryColumn (manual
    // PK) always falls through to INSERT and trips ER_DUP_ENTRY here.
    const wrap = (n: string) => this.em.wrap(n);
    const tbl = wrap("idempotency_key");
    const cKey = wrap("key");
    const cStatus = wrap("status");
    const cHttp = wrap("http_status");
    const cResponse = wrap("response");
    const responseJson =
      response === undefined || response === null
        ? null
        : JSON.stringify(response);
    await this.em.query(sql`
      UPDATE ${raw(tbl)}
         SET ${raw(cStatus)} = ${"completed"},
             ${raw(cHttp)} = ${httpStatus},
             ${raw(cResponse)} = ${responseJson}
       WHERE ${raw(cKey)} = ${key}
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
