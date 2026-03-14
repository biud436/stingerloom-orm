import { Column, CreateTimestamp, Entity, OneToMany, PrimaryGeneratedColumn, UniqueIndex, UpdateTimestamp } from "@stingerloom/orm";
import { Order } from "./order.entity";

@Entity()
export class Customer {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @Column()
  name!: string;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @OneToMany(() => Order, { mappedBy: "customer" })
  orders!: Order[];

}
