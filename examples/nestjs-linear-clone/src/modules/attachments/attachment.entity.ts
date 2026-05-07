import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  BeforeInsert,
} from "@stingerloom/orm";
import { User } from "../users/user.entity";

/** Discriminator value for the polymorphic owner. */
export const ATTACHMENT_OWNER = {
  ISSUE: "ISSUE",
  COMMENT: "COMMENT",
} as const;
export type AttachmentOwnerType =
  (typeof ATTACHMENT_OWNER)[keyof typeof ATTACHMENT_OWNER];

/**
 * Polymorphic attachment with a discriminator column. The example #304 calls
 * out the "discriminator-column workaround (no @Polymorphic decorator)" — we
 * model `(ownerType, ownerId)` as a denormalized FK pair.
 *
 * Trade-off (intentional, documented for the showcase): no DB-level FK on
 * (ownerType, ownerId). Integrity is enforced at the service layer by
 * verifying the parent row exists before insert.
 *
 * Composite index `(owner_type, owner_id)` covers the per-owner list scan.
 */
@Entity()
@Index(["owner_type", "owner_id"])
@Index(["uploaded_by_id"])
export class Attachment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 16 })
  ownerType!: AttachmentOwnerType;

  @Column({ type: "int" })
  ownerId!: number;

  @Column({ length: 255 })
  filename!: string;

  @Column({ length: 128 })
  contentType!: string;

  @Column({ type: "int" })
  sizeBytes!: number;

  // The opaque storage handle. In a real deployment this would point at S3
  // / GCS / etc; for the example we just store an arbitrary URI.
  @Column({ length: 1024 })
  storageUrl!: string;

  @ManyToOne(() => User, () => undefined)
  @RelationColumn({ name: "uploaded_by_id", nullable: true })
  uploadedBy!: User | null;

  uploadedById?: number | null;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    this.createdAt = new Date();
  }
}
