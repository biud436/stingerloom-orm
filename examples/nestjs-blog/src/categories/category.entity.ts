import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
} from "@stingerloom/orm";
import { Post } from "../posts/post.entity";

@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ type: "text", nullable: true })
  description!: string;

  @OneToMany(() => Post, { mappedBy: "category" })
  posts!: Post[];
}
