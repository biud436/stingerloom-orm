import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  ManyToMany,
  RelationColumn,
  DeletedAt,
  UniqueIndex,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { User } from "../users/user.entity";
import { Category } from "../categories/category.entity";
import { Tag } from "../tags/tag.entity";

@Entity()
@UniqueIndex(["slug"])
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  slug!: string;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "int", nullable: true })
  viewCount!: number;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @DeletedAt()
  deletedAt!: Date | null;

  @ManyToOne(() => User, (user) => user.posts, {
    eager: true,
  })
  @RelationColumn({ name: "author_id" })
  author!: User;

  authorId?: number;

  @ManyToOne(() => Category, (category) => category.posts, {
    eager: true,
  })
  @RelationColumn({ name: "category_id" })
  category!: Category;

  categoryId?: number;

  @ManyToMany(() => Tag, {
    joinTable: {
      name: "post_tags",
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    },
  })
  tags!: Tag[];

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    if (this.viewCount === undefined || this.viewCount === null) {
      this.viewCount = 0;
    }
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
