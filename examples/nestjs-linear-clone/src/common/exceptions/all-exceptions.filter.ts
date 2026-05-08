import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Response } from "express";
import {
  OptimisticLockError,
  EntityNotFoundError,
  PrimaryKeyNotFoundError,
  DeleteWithoutConditionsError,
  InvalidQueryError,
  ValidationError as OrmValidationError,
  TransactionError,
  QueryTimeoutError,
  AdvisoryLockError,
  OrmError,
} from "@stingerloom/orm";
import { RequestContextStore } from "../context/request-context";

/**
 * Discriminator for downstream consumers (frontend, retries, alerting).
 * Stable across versions; callers should switch on `code`, not `message`.
 */
export type ErrorEnvelope = {
  status: number;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  details?: unknown;
};

const PG_FK_VIOLATION = "23503";
const PG_UNIQUE_VIOLATION = "23505";
const PG_NOT_NULL = "23502";
const MYSQL_FK_VIOLATION = ["ER_NO_REFERENCED_ROW_2", "ER_ROW_IS_REFERENCED_2"];
const MYSQL_DUP = ["ER_DUP_ENTRY"];

/**
 * Single error filter for the whole app. Maps:
 *
 *   - `HttpException`              → keep as-is
 *   - `OptimisticLockError`        → 409 (`OPTIMISTIC_LOCK`)
 *   - `EntityNotFoundError`        → 404
 *   - `OrmValidationError`         → 422
 *   - `QueryTimeoutError`          → 504
 *   - `AdvisoryLockError`          → 423 (Locked)
 *   - FK / unique violations       → 422 (`CONSTRAINT_VIOLATION`)
 *   - everything else              → 500 with `INTERNAL` and a logged stack
 *
 * The wire response is always an `ErrorEnvelope`; raw stacks never leave the
 * server. The `requestId` is read from `RequestContext` so the client can
 * quote it back when reporting an issue.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const reqId = RequestContextStore.get()?.requestId ?? "unknown";
    const envelope = this.toEnvelope(exception, reqId);

    if (envelope.status >= 500) {
      this.logger.error(
        `[${reqId}] ${envelope.code}: ${envelope.message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (envelope.status >= 400) {
      this.logger.warn(`[${reqId}] ${envelope.code}: ${envelope.message}`);
    }

    res.status(envelope.status).json(envelope);
  }

  private toEnvelope(exception: unknown, requestId: string): ErrorEnvelope {
    const timestamp = new Date().toISOString();
    const base = { requestId, timestamp };

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const status = exception.getStatus();
      if (typeof body === "object" && body !== null) {
        const obj = body as Record<string, unknown>;
        const rawMessage = (obj.message ?? exception.message) as
          | string
          | string[];
        const message = Array.isArray(rawMessage)
          ? rawMessage.join(", ")
          : rawMessage;
        // Lift custom fields (code, currentVersion, …) from the throw body
        // onto the envelope so callers can switch on stable codes and read
        // protocol-specific fields without unwrapping a `details` blob.
        return {
          ...base,
          ...obj,
          status,
          code:
            typeof obj.code === "string" ? obj.code : this.codeFromHttp(exception),
          message,
        };
      }
      return {
        ...base,
        status,
        code: this.codeFromHttp(exception),
        message: typeof body === "string" ? body : exception.message,
      };
    }

    if (exception instanceof OptimisticLockError) {
      return {
        ...base,
        status: HttpStatus.CONFLICT,
        code: "OPTIMISTIC_LOCK",
        message: "Row was modified by another writer; refetch and retry",
      };
    }

    if (exception instanceof EntityNotFoundError || exception instanceof PrimaryKeyNotFoundError) {
      return {
        ...base,
        status: HttpStatus.NOT_FOUND,
        code: "NOT_FOUND",
        message: exception.message,
      };
    }

    if (exception instanceof OrmValidationError) {
      return {
        ...base,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: "ORM_VALIDATION",
        message: exception.message,
      };
    }

    if (exception instanceof QueryTimeoutError) {
      return {
        ...base,
        status: HttpStatus.GATEWAY_TIMEOUT,
        code: "QUERY_TIMEOUT",
        message: "Query exceeded the server time budget",
      };
    }

    if (exception instanceof AdvisoryLockError) {
      return {
        ...base,
        status: 423, // 423 Locked — not in @nestjs/common's HttpStatus enum
        code: "ADVISORY_LOCK",
        message: exception.message,
      };
    }

    if (exception instanceof DeleteWithoutConditionsError || exception instanceof InvalidQueryError) {
      return {
        ...base,
        status: HttpStatus.BAD_REQUEST,
        code: "INVALID_QUERY",
        message: exception.message,
      };
    }

    if (exception instanceof TransactionError) {
      return {
        ...base,
        status: HttpStatus.CONFLICT,
        code: "TRANSACTION",
        message: exception.message,
      };
    }

    const constraint = this.mapDbConstraintError(exception);
    if (constraint) {
      return { ...base, ...constraint };
    }

    if (exception instanceof OrmError) {
      return {
        ...base,
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: exception.code ?? "ORM_ERROR",
        message: exception.message,
      };
    }

    return {
      ...base,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: "INTERNAL",
      message: "Internal server error",
    };
  }

  /** Map raw mysql2/pg driver errors to a 422 with a stable code. */
  private mapDbConstraintError(
    exception: unknown,
  ): Pick<ErrorEnvelope, "status" | "code" | "message"> | null {
    const e = exception as { code?: string; sqlState?: string; detail?: string; message?: string } | null;
    if (!e || typeof e.code !== "string") return null;

    if (e.code === PG_FK_VIOLATION || MYSQL_FK_VIOLATION.includes(e.code)) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: "FK_VIOLATION",
        message: e.detail ?? e.message ?? "Foreign key constraint failed",
      };
    }
    if (e.code === PG_UNIQUE_VIOLATION || MYSQL_DUP.includes(e.code)) {
      return {
        status: HttpStatus.CONFLICT,
        code: "UNIQUE_VIOLATION",
        message: e.detail ?? e.message ?? "Unique constraint failed",
      };
    }
    if (e.code === PG_NOT_NULL) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: "NOT_NULL_VIOLATION",
        message: e.detail ?? e.message ?? "Required column was null",
      };
    }
    return null;
  }

  private codeFromHttp(exception: HttpException): string {
    switch (exception.getStatus()) {
      case 400:
        return "BAD_REQUEST";
      case 401:
        return "UNAUTHORIZED";
      case 403:
        return "FORBIDDEN";
      case 404:
        return "NOT_FOUND";
      case 409:
        return "CONFLICT";
      case 422:
        return "UNPROCESSABLE";
      case 429:
        return "RATE_LIMITED";
      default:
        return "HTTP_ERROR";
    }
  }
}
