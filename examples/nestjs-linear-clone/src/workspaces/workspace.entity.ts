import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  UniqueIndex,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Project } from "../projects/project.entity";
import { Membership } from "../memberships/membership.entity";

@Entity()
@UniqueIndex(["slug"])
export class Workspace {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  slug!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @OneToMany(() => Project, { mappedBy: "workspace" })
  projects!: Project[];

  @OneToMany(() => Membership, { mappedBy: "workspace" })
  memberships!: Membership[];

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
