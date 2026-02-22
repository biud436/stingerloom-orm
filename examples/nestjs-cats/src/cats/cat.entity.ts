import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  DeletedAt,
  Version,
  BeforeInsert,
  AfterInsert,
  BeforeUpdate,
} from "stingerloom-orm";
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
   * @Version — 낙관적 잠금(Optimistic Locking). 동시 수정 시 충돌 감지.
   */
  @Version()
  version!: number;

  /**
   * @DeletedAt — Soft Delete 지원. 실제로 행을 삭제하지 않고 타임스탬프 기록.
   * find/findOne은 자동으로 deleted_at IS NULL 조건이 추가됨.
   */
  @DeletedAt()
  deletedAt!: Date | null;

  /**
   * @ManyToOne — 고양이는 한 명의 주인에게 속합니다.
   * eager: true → findOne 시 LEFT JOIN으로 owner를 자동 로드.
   */
  @ManyToOne(() => Owner, (owner) => owner.cats, {
    joinColumn: "owner_id",
    eager: true,
  })
  owner!: Owner;

  /**
   * @BeforeInsert — INSERT 직전에 createdAt, updatedAt을 자동 설정.
   */
  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
  }

  /**
   * @BeforeUpdate — UPDATE 직전에 updatedAt을 자동 갱신.
   */
  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }

  /**
   * @AfterInsert — INSERT 완료 후 로그 출력 (훅 데모).
   */
  @AfterInsert()
  logInsert() {
    console.log(`[Cat] Inserted: id=${this.id}, name=${this.name}`);
  }
}
