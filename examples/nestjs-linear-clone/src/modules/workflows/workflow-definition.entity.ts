import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  UniqueIndex,
  CreateTimestamp,
} from "@stingerloom/orm";
import { Project } from "../projects/project.entity";

// One row per project; transition rules live in WorkflowTransition.
@Entity()
@UniqueIndex(["project_id"])
export class WorkflowDefinition {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Project, () => undefined)
  @RelationColumn({ name: "project_id" })
  project!: Project;

  projectId?: number;

  @Column({ type: "json" })
  states!: string[];

  @CreateTimestamp()
  createdAt!: Date;
}
