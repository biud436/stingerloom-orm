import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  qAlias,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { WebhookEndpoint } from "./webhook-endpoint.entity";
import { WebhookDelivery } from "./webhook-delivery.entity";
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
} from "./dto/webhook.dto";
import { assertSafeWebhookUrl } from "./ssrf-guard";

/**
 * Outbox-pattern webhook publisher.
 *
 * `emit()` writes one `WebhookDelivery` row per matching active endpoint
 * INSIDE the caller's transaction — so the events fan out atomically with
 * the row write that triggered them. The actual HTTP POST is done out-of-band
 * by `WebhookDeliveryWorker.tick()`.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @InjectRepository(WebhookEndpoint)
    private readonly endpoints: BaseRepository<WebhookEndpoint>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveries: BaseRepository<WebhookDelivery>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  // ── Endpoint CRUD ───────────────────────────────────────

  @Transactional()
  async createEndpoint(dto: CreateWebhookEndpointDto): Promise<WebhookEndpoint> {
    await assertSafeWebhookUrl(dto.url);
    const ep = new WebhookEndpoint();
    ep.workspaceId = dto.workspaceId;
    ep.url = dto.url;
    ep.secret = dto.secret;
    ep.events = dto.events;
    ep.isActive = dto.isActive ?? true;
    return this.endpoints.save(ep);
  }

  listEndpoints(workspaceId: number): Promise<WebhookEndpoint[]> {
    const e = qAlias(WebhookEndpoint, "e");
    return this.endpoints
      .createQueryBuilder(e)
      .where(e.workspaceId.eq(workspaceId))
      .orderBy(e.id.asc())
      .getMany();
  }

  async findEndpoint(id: number): Promise<WebhookEndpoint> {
    const ep = await this.endpoints.findOne({ where: { id } });
    if (!ep) throw new NotFoundException(`Webhook endpoint ${id} not found`);
    return ep;
  }

  @Transactional()
  async updateEndpoint(
    id: number,
    dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpoint> {
    const ep = await this.findEndpoint(id);
    // Cross-tenant guard: the WorkspaceMemberGuard only proves the caller is a
    // member of `dto.workspaceId`; it does NOT prove the endpoint belongs to
    // that workspace. Pin the two together so a member of workspace B cannot
    // patch an endpoint owned by workspace A by passing their own workspace id.
    if (ep.workspaceId !== dto.workspaceId) {
      throw new ForbiddenException(
        "Webhook endpoint does not belong to the specified workspace",
      );
    }
    if (dto.url !== undefined) {
      await assertSafeWebhookUrl(dto.url);
      ep.url = dto.url;
    }
    if (dto.secret !== undefined) ep.secret = dto.secret;
    if (dto.events !== undefined) ep.events = dto.events;
    if (dto.isActive !== undefined) ep.isActive = dto.isActive;
    return this.endpoints.save(ep);
  }

  @Transactional()
  async deleteEndpoint(id: number): Promise<void> {
    const ep = await this.findEndpoint(id);
    await this.endpoints.delete({ id: ep.id });
  }

  // ── Outbox emit ─────────────────────────────────────────

  /**
   * Insert one `WebhookDelivery` row per active endpoint subscribed to
   * `eventType`. Must be called INSIDE the caller's `@Transactional()` so the
   * row writes (issue update, etc.) and outbox entries commit atomically.
   *
   * Returns the number of rows inserted (0 when no endpoint subscribes —
   * a no-op event still costs only the SELECT to discover that fact).
   */
  async emit(
    workspaceId: number,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const e = qAlias(WebhookEndpoint, "e");
    const targets = await this.endpoints
      .createQueryBuilder(e)
      .where(e.workspaceId.eq(workspaceId))
      .andWhere(e.isActive.eq(true))
      .getMany();

    const matching = targets.filter(
      (ep) => Array.isArray(ep.events) && ep.events.includes(eventType),
    );
    if (matching.length === 0) return 0;

    const now = new Date();
    let inserted = 0;
    for (const ep of matching) {
      const row = new WebhookDelivery();
      row.endpointId = ep.id;
      row.eventType = eventType;
      row.payload = payload;
      row.state = "pending";
      row.attemptCount = 0;
      row.nextAttemptAt = now;
      row.lastAttemptedAt = null;
      row.lastError = null;
      row.idempotencyKey = makeDeliveryKey(ep.id, eventType, payload);
      try {
        await this.deliveries.save(row);
        inserted++;
      } catch (err) {
        // UNIQUE collision on idempotencyKey is the writer-side dedupe — same
        // logical event from a retry; swallow it. Surface anything else.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return inserted;
  }

  // ── Manual replay (admin) ───────────────────────────────

  @Transactional()
  async replayDelivery(deliveryId: number): Promise<WebhookDelivery> {
    const d = await this.deliveries.findOne({ where: { id: deliveryId } });
    if (!d) {
      throw new NotFoundException(`Webhook delivery ${deliveryId} not found`);
    }
    d.state = "pending";
    d.nextAttemptAt = new Date();
    d.lastError = null;
    return this.deliveries.save(d);
  }
}

/**
 * DETERMINISTIC digest of the *logical event identity* — `(endpoint, event
 * type, source entity id, version/revision marker)`. There is no time- or
 * UUID-based salt: re-emitting the SAME logical event (e.g. a retried,
 * partially-committed transaction that fires `emit()` again) produces the SAME
 * key, so the `@UniqueIndex(["idempotency_key"])` on `WebhookDelivery` drops
 * the duplicate INSERT and the worker fires exactly once.
 *
 * Logical identity is read off the emitted `payload`:
 *   - `payload.id`      → the source entity that the event is about (issue id).
 *   - `payload.version` → a monotonic per-entity revision marker. For
 *                         `issue.updated` this is the issue's `@Version`, so two
 *                         genuinely-different updates of the same issue (v3 vs
 *                         v4) get distinct keys and BOTH fire, while a retry of
 *                         the same update (same version) collides and de-dupes.
 *                         For events without a version (e.g. `issue.created`,
 *                         which is a once-per-entity event) the marker is empty
 *                         and the `(endpoint, event, id)` triple is the
 *                         identity — re-emitting a create collides, as intended.
 *
 * `endpointId` is included so fan-out to N endpoints yields N distinct rows
 * (each endpoint must receive its own delivery), but two distinct logical
 * events never collide because the entity id + version differ.
 */
function makeDeliveryKey(
  endpointId: number,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  const entityId = stableScalar(payload.id);
  const version = stableScalar(payload.version);
  return createHash("sha256")
    .update(`${endpointId}|${eventType}|${entityId}|${version}`)
    .digest("hex")
    .slice(0, 64);
}

/** Render a payload field into a stable string component of the digest. */
function stableScalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  // Defensive: a non-scalar id/version is unexpected, but hash its JSON so the
  // key stays deterministic rather than throwing inside the outbox write.
  return JSON.stringify(value);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string } | null;
  if (!e || typeof e.code !== "string") return false;
  return e.code === "23505" || e.code === "ER_DUP_ENTRY";
}
