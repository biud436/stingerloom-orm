import { Entity, Column, PrimaryGeneratedColumn } from "stingerloom-orm";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    length: 255,
    nullable: false,
    type: "varchar",
  })
  name!: string;

  @Column({
    type: "int",
    nullable: false,

    length: 11,
  })
  age!: number;

  @Column({
    length: 255,
    nullable: false,
    type: "varchar",
  })
  breed!: string;

  @Column({
    type: "datetime",
    nullable: false,
    length: 6,
  })
  createdAt!: Date;
}
