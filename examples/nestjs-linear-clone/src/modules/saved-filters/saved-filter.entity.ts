import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  CreateTimestamp,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  UpdateTimestamp,
} from "@stingerloom/orm";
import { User } from "../users/user.entity";
import { Workspace } from "../workspaces/workspace.entity";
import { SavedFilterDefinition } from "./dto/saved-filter.dto";

@Entity()
@Index(["workspace_id", "owner_id"])
export class SavedFilter {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Workspace, (w) => w.projects)
  @RelationColumn({ name: "workspace_id" })
  workspace!: Workspace;

  workspaceId?: number;

  @ManyToOne(() => User, (u) => u.assignedIssues)
  @RelationColumn({ name: "owner_id" })
  owner!: User;

  ownerId?: number;

  @Column({ length: 128 })
  name!: string;

  @Column({ type: "json" })
  definition!: SavedFilterDefinition;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

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
