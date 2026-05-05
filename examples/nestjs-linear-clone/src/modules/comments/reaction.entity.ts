import { Entity, Column, PrimaryColumn, Index, CreateTimestamp } from "@stingerloom/orm";

/**
 * Composite-PK reaction row. The triple (commentId, userId, emoji) is the
 * natural identity — re-adding the same reaction collides on the PK so the
 * controller can leverage `INSERT ... ON CONFLICT DO NOTHING` (PG) /
 * `INSERT IGNORE` (MySQL) for an idempotent POST.
 *
 * No `@ManyToOne` here on purpose: the join-table style keeps the row narrow
 * and lets us aggregate via raw SQL (`GROUP BY emoji`) without paying for an
 * eager-load round trip.
 */
@Entity()
@Index(["comment_id"])
export class Reaction {
  @PrimaryColumn({ name: "comment_id", type: "int" })
  commentId!: number;

  @PrimaryColumn({ name: "user_id", type: "int" })
  userId!: number;

  @PrimaryColumn({ length: 32 })
  emoji!: string;

  @CreateTimestamp()
  createdAt!: Date;
}
