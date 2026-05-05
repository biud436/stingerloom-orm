import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
} from "@stingerloom/orm";
import { Comment } from "./comment.entity";
import { User } from "../users/user.entity";

/**
 * Append-only revision history for a Comment. One row per edit, written
 * inside the same transaction as the UPDATE so the snapshot can never drift
 * from the live row. The stored `body` is the *pre-edit* value — readers of
 * `/comments/:id/revisions` see what was replaced, with the current body
 * still living on the Comment row.
 */
@Entity()
@Index(["comment_id", "edited_at"])
export class CommentRevision {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Comment, () => undefined)
  @RelationColumn({ name: "comment_id" })
  comment!: Comment;

  commentId?: number;

  @Column({ type: "text" })
  body!: string;

  @ManyToOne(() => User, () => undefined)
  @RelationColumn({ name: "editor_id", nullable: true })
  editor!: User | null;

  editorId?: number | null;

  @Column({ type: "datetime" })
  editedAt!: Date;
}
