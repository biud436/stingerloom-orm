import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  BeforeInsert,
} from "@stingerloom/orm";

export type IdempotencyStatus = "in_flight" | "completed";

/**
 * Stripe-style Idempotency-Key store.
 *
 * `key` is the client-supplied `Idempotency-Key` header (PK so dupes collide
 * deterministically). `requestHash` is a hash of `(method, path, body)` —
 * mismatched hash on the same key is a 422 client bug, not a replay.
 *
 * On completion the row records `httpStatus` + `response` so the next replay
 * can return the cached body verbatim. `expiresAt` is a 24h TTL the caller
 * should sweep with a separate cron — the interceptor itself never deletes.
 */
@Entity()
@Index(["expires_at"])
export class IdempotencyKey {
  @PrimaryColumn({ length: 128 })
  key!: string;

  @Column({ type: "int", nullable: true })
  userId!: number | null;

  @Column({ length: 64 })
  requestHash!: string;

  @Column({ length: 16 })
  status!: IdempotencyStatus;

  @Column({ type: "int", nullable: true })
  httpStatus!: number | null;

  @Column({ type: "json", nullable: true })
  response!: unknown;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime" })
  expiresAt!: Date;

  @BeforeInsert()
  setDefaults() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}
