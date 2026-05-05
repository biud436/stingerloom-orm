import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  UniqueIndex,
  BeforeInsert,
} from "@stingerloom/orm";
import { WebhookEndpoint } from "./webhook-endpoint.entity";

export type WebhookDeliveryState =
  | "pending"
  | "in_flight"
  | "delivered"
  | "failed";

/**
 * Transactional outbox row for a webhook delivery. The writer (e.g.
 * IssuesService.update) inserts one of these inside the same `@Transactional`
 * frame as the row write, so we never publish events for rolled-back writes
 * and never lose events on commit.
 *
 * The worker claims `pending` rows whose `next_attempt_at <= NOW()` via
 * `SKIP LOCKED` (PG) or the sentinel pattern (MySQL), POSTs the payload, and
 * either flips state to `delivered` or reschedules with exponential backoff.
 *
 * `idempotency_key` is the writer-side dedupe — if the same logical event is
 * emitted twice (e.g. retry of a partially-committed transaction), the
 * UNIQUE index drops the duplicate at INSERT time.
 */
@Entity()
@Index(["state", "next_attempt_at"])
@Index(["endpoint_id", "created_at"])
@UniqueIndex(["idempotency_key"])
export class WebhookDelivery {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => WebhookEndpoint, () => undefined)
  @RelationColumn({ name: "endpoint_id" })
  endpoint!: WebhookEndpoint;

  endpointId?: number;

  @Column({ length: 64 })
  eventType!: string;

  @Column({ type: "json" })
  payload!: Record<string, unknown>;

  @Column({ length: 16 })
  state!: WebhookDeliveryState;

  @Column({ type: "int", default: 0 })
  attemptCount!: number;

  @Column({ type: "datetime", nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  lastAttemptedAt!: Date | null;

  @Column({ type: "text", nullable: true })
  lastError!: string | null;

  @Column({ length: 64 })
  idempotencyKey!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @BeforeInsert()
  setDefaults() {
    if (!this.createdAt) this.createdAt = new Date();
    if (this.attemptCount === undefined) this.attemptCount = 0;
    if (!this.state) this.state = "pending";
  }
}
