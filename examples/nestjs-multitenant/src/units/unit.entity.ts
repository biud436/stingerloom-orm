import {
  Column,
  CreateTimestamp,
  Entity,
  PrimaryGeneratedColumn,
  UpdateTimestamp,
} from "@stingerloom/orm";

/**
 * Shared reference table.
 *
 * `schema: "public"` pins the table: it is always addressed as
 * `"public"."unit"`, whatever tenant the request runs under, so every tenant
 * reads the same rows and `TenantSchemaService` never clones it into a tenant
 * schema. `User` and `Post` stay per-tenant.
 */
@Entity({ schema: "public" })
export class Unit {
  @PrimaryGeneratedColumn("uuid-v7")
  id!: string;

  @Column({
    nullable: true,
    default: true,
  })
  active!: boolean;

  @Column()
  unitNumber!: string;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;
}
