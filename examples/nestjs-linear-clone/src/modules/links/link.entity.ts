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

export type IssueLinkType = "blocks" | "blockedBy" | "relatesTo" | "duplicates";

@Entity()
@UniqueIndex(["source_issue_id", "target_issue_id", "type"])
@Index(["target_issue_id", "type"])
export class IssueLink {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Issue, () => undefined, { fkProperty: "sourceIssueId" })
  @RelationColumn({ name: "source_issue_id" })
  source!: Issue;

  sourceIssueId?: number;

  @ManyToOne(() => Issue, () => undefined, { fkProperty: "targetIssueId" })
  @RelationColumn({ name: "target_issue_id" })
  target!: Issue;

  targetIssueId?: number;

  @Column({ length: 16 })
  type!: IssueLinkType;

  @Column({ type: "int", nullable: true })
  createdBy!: number | null;

  @CreateTimestamp()
  createdAt!: Date;
}
