import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  ManyToMany,
  OneToMany,
  RelationColumn,
  UniqueIndex,
  Index,
  FullTextIndex,
  Version,
  DeletedAt,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Project } from "../projects/project.entity";
import { Sprint } from "../sprints/sprint.entity";
import { User } from "../users/user.entity";
import { Label } from "../labels/label.entity";
import { Comment } from "../comments/comment.entity";
import { IssueStatus, IssuePriority, ISSUE_STATUS } from "../common/enums";

/**
 * Self-referencing parent column powers the recursive subissue tree.
 * @Version drives optimistic locking; conflicting concurrent edits surface as
 * an OptimisticLockError instead of silently overwriting.
 * `claimedBy` / `claimedAt` are the SKIP LOCKED auto-assign columns.
 * `customFields` is a JSON blob whose schema is declared per Project.
 */
@Entity()
@UniqueIndex(["project_id", "number"])
@Index(["project_id", "status"])
@Index(["assignee_id"])
@Index(["parent_id"])
@Index(["sprint_id"])
@FullTextIndex(["title", "description"])
export class Issue {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Project, (p) => p.issues)
  @RelationColumn({ name: "project_id" })
  project!: Project;

  projectId?: number;

  @Column({ type: "int" })
  number!: number;

  @Column()
  title!: string;

  @Column({ type: "text", nullable: true })
  description!: string;

  @Column({ length: 16 })
  status!: IssueStatus;

  @Column({ type: "int", nullable: true })
  priority!: IssuePriority;

  @Column({ type: "int", nullable: true })
  estimate!: number | null;

  @ManyToOne(() => Sprint, (s) => s.issues)
  @RelationColumn({ name: "sprint_id", nullable: true })
  sprint!: Sprint | null;

  sprintId?: number | null;

  @ManyToOne(() => User, (u) => u.assignedIssues)
  @RelationColumn({ name: "assignee_id", nullable: true })
  assignee!: User | null;

  assigneeId?: number | null;

  @ManyToOne(() => User, (u) => u.reportedIssues)
  @RelationColumn({ name: "reporter_id", nullable: true })
  reporter!: User | null;

  reporterId?: number | null;

  @ManyToOne(() => Issue, (i) => i.children)
  @RelationColumn({ name: "parent_id", nullable: true })
  parent!: Issue | null;

  parentId?: number | null;

  @OneToMany(() => Issue, { mappedBy: "parent" })
  children!: Issue[];

  @Column({ type: "json", nullable: true })
  customFields!: Record<string, unknown> | null;

  @Column({ length: 64, nullable: true })
  claimedBy!: string | null;

  @Column({ type: "datetime", nullable: true })
  claimedAt!: Date | null;

  @Version()
  version!: number;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;

  @DeletedAt()
  deletedAt!: Date | null;

  @ManyToMany(() => Label, {
    joinTable: {
      name: "issue_labels",
      joinColumn: "issue_id",
      inverseJoinColumn: "label_id",
    },
  })
  labels!: Label[];

  @OneToMany(() => Comment, { mappedBy: "issue" })
  comments!: Comment[];

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    if (!this.status) this.status = ISSUE_STATUS.BACKLOG;
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
