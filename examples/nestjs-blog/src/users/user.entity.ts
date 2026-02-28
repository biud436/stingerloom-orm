import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  UniqueIndex,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Post } from "../posts/post.entity";

@Entity()
@UniqueIndex(["email"])
@UniqueIndex(["username"])
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  username!: string;

  @Column()
  email!: string;

  @Column({ type: "text", nullable: true })
  bio!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @OneToMany(() => Post, { mappedBy: "author" })
  posts!: Post[];

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
