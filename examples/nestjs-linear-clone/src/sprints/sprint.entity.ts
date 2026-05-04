import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  RelationColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Project } from "../projects/project.entity";
import { Issue } from "../issues/issue.entity";
import { SprintStatus } from "../common/enums";

@Entity()
@Index(["project_id", "status"])
export class Sprint {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Project, (p) => p.sprints)
  @RelationColumn({ name: "project_id" })
  project!: Project;

  projectId?: number;

  @Column()
  name!: string;

  @Column({ length: 16 })
  status!: SprintStatus;

  @Column({ type: "datetime", nullable: true })
  startDate!: Date | null;

  @Column({ type: "datetime", nullable: true })
  endDate!: Date | null;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @OneToMany(() => Issue, { mappedBy: "sprint" })
  issues!: Issue[];

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
