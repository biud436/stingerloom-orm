import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  BeforeInsert,
} from "@stingerloom/orm";
import { Cat } from "../cats/cat.entity";

@Entity()
export class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ nullable: true })
  email!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  /**
   * @OneToMany — an owner can own many cats.
   * mappedBy: the Cat entity's "owner" property is the owning side (holds the FK).
   */
  @OneToMany(() => Cat, { mappedBy: "owner" })
  cats!: Cat[];

  /**
   * @BeforeInsert — set createdAt automatically before INSERT.
   */
  @BeforeInsert()
  setCreatedAt() {
    this.createdAt = new Date();
  }
}
