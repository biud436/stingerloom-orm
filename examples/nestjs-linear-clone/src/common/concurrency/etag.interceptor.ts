import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Observable, of } from "rxjs";
import { map } from "rxjs/operators";

/**
 * Lifts Stingerloom's `@Version` (optimistic-lock counter) to HTTP-native
 * concurrency primitives.
 *
 * On every successful response whose body has a numeric `version` field:
 *
 *   - Sets `ETag: W/"<version>"`. Weak validators because the body bytes
 *     can vary per-request (e.g. snake/camel renames in serializers) but
 *     the resource version is the authoritative identity.
 *   - On `GET` requests, if `If-None-Match` matches the chosen ETag,
 *     short-circuits to a 304 Not Modified with no body.
 *
 * On any non-`GET` (PATCH / PUT / DELETE) request that carries an
 * `If-Match` header, the interceptor parses the bound version. The
 * controller / service is responsible for calling `assertIfMatch(req,
 * currentVersion)` (helper exported below) to compare it with the loaded
 * row and raise 412 on mismatch — the interceptor does not see the
 * loaded row and so cannot do the comparison itself.
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    return next.handle().pipe(
      map((body: unknown) => {
        const version = pickVersion(body);
        if (version === undefined) return body;

        const etag = `W/"${version}"`;
        res.setHeader("ETag", etag);

        if (req.method === "GET") {
          const inm = req.header("if-none-match");
          if (inm && etagsMatch(inm, etag)) {
            res.status(HttpStatus.NOT_MODIFIED);
            res.end();
            return undefined;
          }
        }

        return body;
      }),
    );
  }
}

/**
 * Throw 412 Precondition Failed when the request carries `If-Match` and
 * the bound version does not match `currentVersion`. Call this from the
 * write service AFTER loading the row but BEFORE issuing the UPDATE.
 *
 * Returns the parsed expected version (or null when the header is absent),
 * which the caller can pass through to `@Version`-driven save() so a
 * concurrent writer that sneaked between header parse and save() still
 * surfaces as the ORM-native 409 OptimisticLockError.
 */
export function assertIfMatch(req: Request, currentVersion: number): number | null {
  const header = req.header("if-match");
  if (!header) return null;
  const parsed = parseIfMatch(header);
  if (parsed === null) {
    throw new HttpException(
      {
        status: HttpStatus.BAD_REQUEST,
        code: "BAD_IF_MATCH",
        message: `Unparseable If-Match header: ${header}`,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (parsed !== currentVersion) {
    throw new HttpException(
      {
        status: HttpStatus.PRECONDITION_FAILED,
        code: "PRECONDITION_FAILED",
        message: `Stale If-Match (expected ${currentVersion}, got ${parsed})`,
        currentVersion,
      },
      HttpStatus.PRECONDITION_FAILED,
    );
  }
  return parsed;
}

function pickVersion(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const v = (body as { version?: unknown }).version;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function parseIfMatch(header: string): number | null {
  // Accept `W/"5"`, `"5"`, or bare `5`. Reject `*` here because the
  // resource-must-exist semantics are different from version locking and
  // the caller likely meant to use `If-None-Match: *` for create-only.
  const trimmed = header.trim();
  if (trimmed === "*") return null;
  const m = trimmed.match(/^(?:W\/)?"?(-?\d+)"?$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function etagsMatch(headerVal: string, computed: string): boolean {
  // RFC 7232 weak-match: strip the W/ prefix from each side before string-compare.
  const norm = (s: string) => s.replace(/^W\//, "").trim();
  const wanted = norm(computed);
  return headerVal
    .split(",")
    .map((s) => norm(s))
    .some((etag) => etag === wanted || etag === "*");
}
