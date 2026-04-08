import {
  Column,
  CreateTimestamp,
  Entity,
  PrimaryGeneratedColumn,
  UpdateTimestamp,
} from "@stingerloom/orm";

@Entity()
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
