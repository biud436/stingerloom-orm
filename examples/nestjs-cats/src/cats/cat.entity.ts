import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  DeletedAt,
  Version,
  BeforeInsert,
  AfterInsert,
  BeforeUpdate,
} from "@stingerloom/orm";
import { Owner } from "../owners/owner.entity";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  age!: number;

  @Column()
  breed!: string;

  @Column({
    type: "datetime",
    nullable: true,
  })
  createdAt!: Date;

  @Column({
    type: "datetime",
    nullable: true,
  })
  updatedAt!: Date;

  /**
   * @Version — Optimistic Locking. Detects conflicts during concurrent updates.
   */
  @Version()
  version!: number;

  /**
   * @DeletedAt — enables Soft Delete. Records a timestamp instead of actually deleting the row.
   * find/findOne automatically append a deleted_at IS NULL condition.
   */
  @DeletedAt()
  deletedAt!: Date | null;

  /**
   * @ManyToOne — a cat belongs to exactly one owner.
   * eager: true → findOne auto-loads owner via LEFT JOIN.
   */
  @ManyToOne(() => Owner, (owner) => owner.cats, {
    eager: true,
  })
  @RelationColumn({ name: "owner_id" })
  owner!: Owner;

  /**
   * FK shorthand — when you set cat.ownerId = 1,
   * the ORM maps it to the owner_id column. Works without a separate @Column.
   */
  ownerId?: number;

  /**
   * @BeforeInsert — sets createdAt and updatedAt automatically right before INSERT.
   */
  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
  }

  /**
   * @BeforeUpdate — refreshes updatedAt automatically right before UPDATE.
   */
  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }

  /**
   * @AfterInsert — logs after INSERT completes (hook demo).
   */
  @AfterInsert()
  logInsert() {
    console.log(`[Cat] Inserted: id=${this.id}, name=${this.name}`);
  }
}
