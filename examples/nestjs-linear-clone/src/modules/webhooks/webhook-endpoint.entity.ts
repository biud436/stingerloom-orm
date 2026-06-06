import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  UniqueIndex,
  BeforeInsert,
} from "@stingerloom/orm";
import { Exclude } from "class-transformer";
import { Workspace } from "../workspaces/workspace.entity";

/**
 * Outbound webhook configuration owned by a workspace. The list of subscribed
 * `events` is stored as a JSON string array; matching is exact-string
 * (`issue.updated`, `issue.created`, …). Body signing uses HMAC-SHA256 over
 * the JSON-stringified payload with `secret` as the key — receivers verify by
 * recomputing the HMAC and constant-time comparing the `X-Webhook-Signature`
 * header.
 */
@Entity()
@Index(["workspace_id"])
@UniqueIndex(["workspace_id", "url"])
export class WebhookEndpoint {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Workspace, () => undefined)
  @RelationColumn({ name: "workspace_id" })
  workspace!: Workspace;

  workspaceId?: number;

  @Column({ length: 512 })
  url!: string;

  /**
   * HMAC signing key. `@Exclude({ toPlainOnly: true })` keeps it out of every
   * serialized controller response (the global `ClassSerializerInterceptor`
   * runs instanceToPlain and honours it) — otherwise any endpoint returning the
   * entity would leak the secret a receiver uses to verify
   * `X-Webhook-Signature`. `toPlainOnly` is required: the ORM deserializes DB
   * rows via plainToClass, so a plain `@Exclude()` would also strip the column
   * on load and the delivery worker's `createHmac(secret)` would get undefined.
   */
  @Exclude({ toPlainOnly: true })
  @Column({ length: 64 })
  secret!: string;

  @Column({ type: "json" })
  events!: string[];

  @Column({ type: "boolean", default: true })
  isActive!: boolean;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    if (!this.createdAt) this.createdAt = new Date();
    if (this.isActive === undefined) this.isActive = true;
  }
}
