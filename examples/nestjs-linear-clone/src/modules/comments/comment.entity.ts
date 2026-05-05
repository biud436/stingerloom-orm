import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  FullTextIndex,
  DeletedAt,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Issue } from "../issues/issue.entity";
import { User } from "../users/user.entity";

@Entity()
@Index(["issue_id"])
@FullTextIndex(["body"])
export class Comment {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Issue, (i) => i.comments)
  @RelationColumn({ name: "issue_id" })
  issue!: Issue;

  issueId?: number;

  @ManyToOne(() => User, (u) => u.comments)
  @RelationColumn({ name: "author_id", nullable: true })
  author!: User | null;

  authorId?: number | null;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @DeletedAt()
  deletedAt!: Date | null;

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
