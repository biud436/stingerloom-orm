import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  ManyToMany,
  DeletedAt,
  Version,
  UniqueIndex,
  BeforeInsert,
  BeforeUpdate,
} from "stingerloom-orm";
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

  @Version()
  version!: number;

  @ManyToOne(() => User, (user) => user.posts, {
    joinColumn: "author_id",
    eager: true,
  })
  author!: User;

  @ManyToOne(() => Category, (category) => category.posts, {
    joinColumn: "category_id",
    eager: true,
  })
  category!: Category;

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
