import {
  Injectable,
  Inject,
  forwardRef,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  OptimisticLockError,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { createHash } from "node:crypto";
import { BulkOperation, BulkRowResult } from "./bulk-operation.entity";
import { BulkUpdateIssuesDto, BulkUpdateResponseDto } from "./dto/bulk.dto";
import { IssuesService } from "../issues/issues.service";

@Injectable()
export class BulkOperationsService {
  constructor(
    @InjectRepository(BulkOperation)
    private readonly repo: BaseRepository<BulkOperation>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
    @Inject(forwardRef(() => IssuesService))
    private readonly issues: IssuesService,
  ) {}

  /**
   * Per-row optimistic update under one BulkOperation envelope. Each row
   * gets its own savepoint so a single conflict does not roll back the
   * other 199 rows. The result envelope reports outcome per id.
   *
   * Idempotency-Key replay flows through the global IdempotencyInterceptor
   * (it caches the response for 24h). This service additionally records
   * the BulkOperation row so analytics can replay the per-row outcome
   * without parsing the cached response body.
   */
  async bulkUpdate(
    dto: BulkUpdateIssuesDto,
    actorUserId: number,
    idempotencyKey: string | null,
  ): Promise<BulkUpdateResponseDto> {
    if (dto.ids.length !== dto.expectedVersions.length) {
      throw new ConflictException(
        `ids.length (${dto.ids.length}) must match expectedVersions.length (${dto.expectedVersions.length})`,
      );
    }

    const requestHash = this.hashRequest(dto);
    const finalKey =
      idempotencyKey ??
      `bulk:auto:${actorUserId}:${requestHash}:${Date.now()}`;

    // Create the envelope row up-front so it is visible mid-flight and a
    // crash leaves a forensic trace.
    const envelope = new BulkOperation();
    envelope.idempotencyKey = finalKey;
    envelope.actorUserId = actorUserId;
    envelope.status = "in_flight";
    envelope.requestHash = requestHash;
    envelope.totalCount = dto.ids.length;
    envelope.successCount = 0;
    envelope.conflictCount = 0;
    envelope.notFoundCount = 0;
    envelope.results = null;
    let saved: BulkOperation;
    try {
      saved = await this.repo.save(envelope);
    } catch (err) {
      // Unique-index collision on idempotencyKey → return the prior envelope
      // verbatim. The IdempotencyInterceptor already handles HTTP-layer
      // replay; this branch covers direct-service callers.
      const existing = await this.repo.findOne({ where: { idempotencyKey: finalKey } });
      if (existing && existing.results) {
        return this.materialize(existing);
      }
      throw err;
    }

    const results: BulkRowResult[] = [];
    for (let i = 0; i < dto.ids.length; i++) {
      const id = dto.ids[i];
      const expectedVersion = dto.expectedVersions[i];
      try {
        const updated = await this.issues.update(
          id,
          {
            expectedVersion,
            ...(dto.patch as Record<string, unknown>),
          } as never,
          actorUserId,
        );
        results.push({ id, status: "ok", version: updated.version });
      } catch (err) {
        results.push(this.classify(id, err));
      }
    }

    saved.status = "completed";
    saved.successCount = results.filter((r) => r.status === "ok").length;
    saved.conflictCount = results.filter((r) => r.status === "conflict").length;
    saved.notFoundCount = results.filter((r) => r.status === "not_found").length;
    saved.results = results;
    await this.repo.save(saved);

    return this.materialize(saved);
  }

  private classify(id: number, err: unknown): BulkRowResult {
    if (err instanceof OptimisticLockError) {
      return { id, status: "conflict" };
    }
    if (err instanceof NotFoundException) {
      return { id, status: "not_found" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { id, status: "error", error: msg };
  }

  private materialize(op: BulkOperation): BulkUpdateResponseDto {
    const results = op.results ?? [];
    return {
      bulkOperationId: op.id,
      results,
      summary: {
        total: op.totalCount,
        ok: op.successCount,
        conflict: op.conflictCount,
        notFound: op.notFoundCount,
        error: results.filter((r) => r.status === "error").length,
      },
    };
  }

  private hashRequest(dto: BulkUpdateIssuesDto): string {
    const canonical = JSON.stringify({
      ids: [...dto.ids].sort((a, b) => a - b),
      expectedVersions: dto.expectedVersions,
      patch: dto.patch,
    });
    return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  }
}
