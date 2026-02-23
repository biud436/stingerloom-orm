import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToMany,
  UniqueIndex,
  BeforeInsert,
} from "stingerloom-orm";
import { Post } from "../posts/post.entity";

@Entity()
@UniqueIndex(["name"])
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @ManyToMany(() => Post, { mappedBy: "tags" })
  posts!: Post[];

  @BeforeInsert()
  setCreatedAt() {
    this.createdAt = new Date();
  }
}
