import { Column, CreateTimestamp, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, RelationColumn, UpdateTimestamp } from "@stingerloom/orm";
import { Customer } from "./customer.entity";
import { OrderItem } from "./order_item.entity";
import { OrderStatus } from "./order_status.enum";

@Entity()
export class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "enum", enumName: "OrderStatus", enumValues: ["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"], default: "PENDING" })
  status!: string;

  @Column({ type: "double", precision: 10, scale: 2 })
  totalAmount!: number;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @ManyToOne(() => Customer, (e) => e.orders)
  @RelationColumn({ name: "customerId" })
  customer!: Customer;

  @OneToMany(() => OrderItem, { mappedBy: "order" })
  items!: OrderItem[];
}
