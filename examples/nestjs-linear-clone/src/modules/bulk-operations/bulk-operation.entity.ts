import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateTimestamp,
  UpdateTimestamp,
  Index,
  UniqueIndex,
} from "@stingerloom/orm";

export type BulkOperationStatus = "in_flight" | "completed";

@Entity()
@UniqueIndex(["idempotency_key"])
@Index(["actor_user_id", "created_at"])
export class BulkOperation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 128 })
  idempotencyKey!: string;

  @Column({ type: "int", nullable: true })
  actorUserId!: number | null;

  @Column({ length: 16 })
  status!: BulkOperationStatus;

  @Column({ length: 64 })
  requestHash!: string;

  @Column({ type: "int" })
  totalCount!: number;

  @Column({ type: "int", default: 0 })
  successCount!: number;

  @Column({ type: "int", default: 0 })
  conflictCount!: number;

  @Column({ type: "int", default: 0 })
  notFoundCount!: number;

  @Column({ type: "json", nullable: true })
  results!: BulkRowResult[] | null;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  completedAt!: Date | null;
}

export interface BulkRowResult {
  id: number;
  status: "ok" | "conflict" | "not_found" | "error";
  version?: number;
  error?: string;
}
