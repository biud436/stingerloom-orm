import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  UniqueIndex,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Exclude } from "class-transformer";
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

  /**
   * bcrypt hash of the user's password. Nullable so seed data and
   * pre-existing rows survive — `AuthService.login` rejects when null.
   *
   * `@Exclude({ toPlainOnly: true })` keeps it out of every controller response
   * (the global `ClassSerializerInterceptor` runs instanceToPlain) WITHOUT
   * stripping it on load: the ORM deserializes DB rows via plainToClass, so a
   * plain `@Exclude()` would also drop the column when loading the entity and
   * `AuthService.login`'s `bcrypt.compare(password, user.passwordHash)` would
   * always see `undefined` (every password login would 401).
   */
  @Exclude({ toPlainOnly: true })
  @Column({ length: 100, nullable: true })
  passwordHash!: string | null;

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
