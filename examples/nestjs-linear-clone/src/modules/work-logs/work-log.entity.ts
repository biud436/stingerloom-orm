import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Issue } from "../issues/issue.entity";
import { User } from "../users/user.entity";

/**
 * One row per time-tracking entry. `loggedAt` is the work date (the day the
 * developer is claiming credit for), distinct from `createdAt` which is the
 * row insert time.
 *
 * Composite index `(issue_id, logged_at)` covers the per-issue daily timeline
 * scan and the sprint velocity rolling-window query.
 */
@Entity()
@Index(["issue_id", "logged_at"])
@Index(["user_id", "logged_at"])
export class WorkLog {
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

  // Hours worked, allowing fractions like 0.25 (15min) or 1.5 (90min).
  @Column({ type: "float" })
  hours!: number;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  // The work date the user is claiming. Indexed for the rolling-window query.
  @Column({ type: "datetime" })
  loggedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    if (!this.loggedAt) this.loggedAt = now;
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
