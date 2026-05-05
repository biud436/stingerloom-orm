import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  CreateTimestamp,
} from "@stingerloom/orm";
import { Issue } from "../issues/issue.entity";
import { User } from "../users/user.entity";

export type NotificationKind =
  | "mention"
  | "status_change"
  | "assigned"
  | "commented"
  | "watching";

/**
 * In-app notification — one row per (recipient × triggering event). Kept
 * normalised (no fan-out fields denormalised onto Issue / Comment) so the
 * inbox query is just `user_id = ? ORDER BY id DESC`.
 *
 * Indexes target the two real read paths:
 *   - inbox feed / unread count → (user_id, read_at)
 *   - per-issue audit fan-out  → (source_issue_id, created_at)
 */
@Entity()
@Index(["user_id", "read_at"])
@Index(["source_issue_id", "created_at"])
export class Notification {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, () => undefined)
  @RelationColumn({ name: "user_id" })
  user!: User;

  userId?: number;

  @ManyToOne(() => Issue, () => undefined)
  @RelationColumn({ name: "source_issue_id" })
  sourceIssue!: Issue;

  sourceIssueId?: number;

  @Column({ length: 32 })
  kind!: NotificationKind;

  @Column({ type: "json", nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: "datetime", nullable: true })
  readAt!: Date | null;

  @CreateTimestamp()
  createdAt!: Date;
}
