import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  UniqueIndex,
  BeforeInsert,
} from "@stingerloom/orm";
import { Project } from "../projects/project.entity";

@Entity()
@UniqueIndex(["project_id", "name"])
export class Label {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Project, (p) => p.labels)
  @RelationColumn({ name: "project_id" })
  project!: Project;

  projectId?: number;

  @Column()
  name!: string;

  @Column({ length: 16, nullable: true })
  color!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}
