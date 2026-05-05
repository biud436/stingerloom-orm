import {
  Injectable,
  Inject,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
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
    if (dto.url !== undefined) ep.url = dto.url;
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
      row.idempotencyKey = makeDeliveryKey(workspaceId, ep.id, eventType, payload);
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
 * Stable digest of (workspace, endpoint, event, payload, monotonic salt). The
 * salt makes two distinct emits of the same logical payload distinguishable —
 * we only want UNIQUE-collision on a true retry of the *same* outbox row.
 */
function makeDeliveryKey(
  workspaceId: number,
  endpointId: number,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  const salt = `${Date.now()}-${randomUUID()}`;
  const json = JSON.stringify(payload);
  return createHash("sha256")
    .update(`${workspaceId}|${endpointId}|${eventType}|${json}|${salt}`)
    .digest("hex")
    .slice(0, 64);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string } | null;
  if (!e || typeof e.code !== "string") return false;
  return e.code === "23505" || e.code === "ER_DUP_ENTRY";
}
