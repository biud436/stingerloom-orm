import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { User } from "../users/user.entity";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "boolean", nullable: true })
  published!: boolean;

  @Column({ type: "timestamp", nullable: true })
  createdAt!: Date;

  @Column({ type: "timestamp", nullable: true })
  updatedAt!: Date;

  @ManyToOne(() => User, (user) => user.posts, {
    eager: true,
  })
  @RelationColumn({ name: "author_id" })
  author!: User;

  authorId?: number;

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    if (this.published === undefined || this.published === null) {
      this.published = false;
    }
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
