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
   * @OneToMany — 주인은 여러 고양이를 소유할 수 있습니다.
   * mappedBy: Cat 엔티티의 "owner" 프로퍼티가 소유자(FK 보유 측).
   */
  @OneToMany(() => Cat, { mappedBy: "owner" })
  cats!: Cat[];

  /**
   * @BeforeInsert — INSERT 전 createdAt 자동 설정.
   */
  @BeforeInsert()
  setCreatedAt() {
    this.createdAt = new Date();
  }
}
