import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  BeforeInsert,
} from "@stingerloom/orm";
import { ActivityAction } from "../../common/enums";
import { jsonColumn } from "../../common/transformers/json.transformer";

/**
 * Append-only audit log. Rows are inserted by the issue/comment/queue
 * services whenever an entity transitions state. The `payload` JSON column
 * stores `{ before, after }` snapshots so the analytics layer can
 * reconstruct status timelines via LAG-window queries.
 *
 * Indexes are tuned for the three real read patterns:
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

  @Column({
    type: "json",
    nullable: true,
    transformer: jsonColumn<Record<string, unknown>>(),
  })
  payload!: Record<string, unknown> | null;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}
