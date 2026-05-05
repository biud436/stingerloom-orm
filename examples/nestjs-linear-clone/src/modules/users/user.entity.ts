import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  UniqueIndex,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Membership } from "../memberships/membership.entity";
import { Issue } from "../issues/issue.entity";
import { Comment } from "../comments/comment.entity";

@Entity()
@UniqueIndex(["email"])
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @Column()
  name!: string;

  @Column({ nullable: true })
  avatarUrl!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @OneToMany(() => Membership, { mappedBy: "user" })
  memberships!: Membership[];

  @OneToMany(() => Issue, { mappedBy: "assignee" })
  assignedIssues!: Issue[];

  @OneToMany(() => Issue, { mappedBy: "reporter" })
  reportedIssues!: Issue[];

  @OneToMany(() => Comment, { mappedBy: "author" })
  comments!: Comment[];

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
