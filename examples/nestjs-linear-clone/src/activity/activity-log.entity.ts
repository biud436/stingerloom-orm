import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  BeforeInsert,
} from "@stingerloom/orm";
import { ActivityAction } from "../common/enums";

/**
 * Append-only audit log. Rows are inserted by ActivitySubscriber whenever
 * issue rows transition state. The `payload` JSON column stores
 * `{ before, after }` snapshots so the analytics layer can reconstruct
 * status timelines via LAG-window queries.
 */
@Entity()
@Index(["issueId", "createdAt"])
@Index(["workspaceId", "createdAt"])
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

  @Column({ type: "json", nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}
