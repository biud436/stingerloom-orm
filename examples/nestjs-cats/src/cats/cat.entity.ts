import { Entity, Column, PrimaryGeneratedColumn } from "stingerloom-orm";

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
    nullable: false,
    length: 6,
  })
  createdAt!: Date;
}
