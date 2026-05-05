import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  UniqueIndex,
  Index,
  CreateTimestamp,
} from "@stingerloom/orm";
import { Issue } from "../issues/issue.entity";
import { User } from "../users/user.entity";

/**
 * A user explicitly subscribing to an issue's lifecycle events. The unique
 * (issue_id, user_id) pair makes (re-)subscribing idempotent. `lastSeenAt`
 * is reserved for "since-I-last-looked" digests; nullable until the user
 * has actually opened the issue at least once.
 */
@Entity()
@UniqueIndex(["issue_id", "user_id"])
@Index(["user_id", "last_seen_at"])
export class IssueWatcher {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Issue, () => undefined)
  @RelationColumn({ name: "issue_id" })
  issue!: Issue;

  issueId?: number;

  @ManyToOne(() => User, () => undefined)
  @RelationColumn({ name: "user_id" })
  user!: User;

  userId?: number;

  @Column({ type: "datetime", nullable: true })
  lastSeenAt!: Date | null;

  @CreateTimestamp()
  createdAt!: Date;
}
