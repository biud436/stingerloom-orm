import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  UniqueIndex,
  Index,
  BeforeInsert,
} from "@stingerloom/orm";
import { Workspace } from "../workspaces/workspace.entity";
import { User } from "../users/user.entity";
import { MembershipRole } from "../../common/enums";

@Entity()
@UniqueIndex(["workspace_id", "user_id"])
@Index(["user_id"])
export class Membership {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Workspace, (w) => w.memberships)
  @RelationColumn({ name: "workspace_id" })
  workspace!: Workspace;

  workspaceId?: number;

  @ManyToOne(() => User, (u) => u.memberships)
  @RelationColumn({ name: "user_id" })
  user!: User;

  userId?: number;

  @Column({ length: 16 })
  role!: MembershipRole;

  @Column({ type: "datetime", nullable: true })
  joinedAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    if (!this.joinedAt) this.joinedAt = new Date();
  }
}
