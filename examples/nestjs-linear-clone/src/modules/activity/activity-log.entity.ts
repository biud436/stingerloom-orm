import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  BeforeInsert,
} from "@stingerloom/orm";
import { ActivityAction } from "../../common/enums";

/**
 * Append-only audit log. Rows are inserted by the issue/comment/queue
 * services whenever an entity transitions state. The `payload` JSON column
 * stores the full column-level diff for human-readable activity feeds.
 *
 * Status transitions are also denormalized into the typed `statusFrom` /
 * `statusTo` columns: analytics queries (time-in-status, status history)
 * can then read a plain string column with LAG/LEAD windows instead of
 * digging vendor-specific JSON-path predicates out of `payload`. The
 * columns are NULL on non-status changes; queries filter on
 * `statusTo IS NOT NULL` to project the status timeline.
 *
 * Indexes are tuned for the four real read patterns:
 *   - per-issue feed       → (issue_id, created_at)
 *   - per-workspace feed   → (workspace_id, created_at)
 *   - "what did this user do" → (actor_user_id, created_at)
 *   - filtering by action  → (action)
 */
@Entity()
@Index(["issue_id", "created_at"])
@Index(["workspace_id", "created_at"])
@Index(["actor_user_id", "created_at"])
@Index(["action"])
@Index(["issue_id", "status_to", "created_at"])
export class ActivityLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int", nullable: true })
  workspaceId!: number | null;

  @Column({ type: "int" })
  issueId!: number;

  @Column({ type: "int", nullable: true })
  actorUserId!: number | null;

  @Column({ length: 32 })
  action!: ActivityAction;

  @Column({ type: "json", nullable: true })
  payload!: Record<string, unknown> | null;

  /**
   * Status transition: previous status (NULL for non-status changes or
   * unknown prior state). Denormalized from `payload.changes` for
   * portable analytics — no JSON-path predicates needed.
   */
  @Column({ type: "varchar", length: 32, nullable: true })
  statusFrom!: string | null;

  /**
   * Status transition: new status. NULL on non-status changes.
   * `WHERE statusTo IS NOT NULL` is the canonical filter for the
   * status-history projection.
   */
  @Column({ type: "varchar", length: 32, nullable: true })
  statusTo!: string | null;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}
