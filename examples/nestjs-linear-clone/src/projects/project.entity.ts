import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  RelationColumn,
  UniqueIndex,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Workspace } from "../workspaces/workspace.entity";
import { Issue } from "../issues/issue.entity";
import { Sprint } from "../sprints/sprint.entity";
import { Label } from "../labels/label.entity";

/**
 * customFieldSchema example:
 * {
 *   "fields": [
 *     { "key": "severity", "type": "enum", "options": ["S0","S1","S2","S3"] },
 *     { "key": "customer", "type": "string" },
 *     { "key": "regressionFrom", "type": "version" }
 *   ]
 * }
 */
@Entity()
@UniqueIndex(["workspace_id", "key"])
export class Project {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Workspace, (w) => w.projects)
  @RelationColumn({ name: "workspace_id" })
  workspace!: Workspace;

  workspaceId?: number;

  @Column()
  name!: string;

  @Column({ length: 16 })
  key!: string;

  @Column({ type: "text", nullable: true })
  description!: string;

  @Column({ type: "json", nullable: true })
  customFieldSchema!: Record<string, unknown> | null;

  @Column({ type: "int", nullable: true })
  issueCounter!: number;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @OneToMany(() => Issue, { mappedBy: "project" })
  issues!: Issue[];

  @OneToMany(() => Sprint, { mappedBy: "project" })
  sprints!: Sprint[];

  @OneToMany(() => Label, { mappedBy: "project" })
  labels!: Label[];

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    if (this.issueCounter == null) this.issueCounter = 0;
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
