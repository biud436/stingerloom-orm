import { Column, Entity, ManyToOne, PrimaryGeneratedColumn, UniqueIndex } from "@stingerloom/orm";
import { Order } from "./order.entity";
import { Product } from "./product.entity";

@Entity()
@UniqueIndex(["orderId", "productId"])
export class OrderItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  quantity!: number;

  @Column({ type: "double", precision: 10, scale: 2 })
  unitPrice!: number;

  @ManyToOne(() => Order, (e) => e.items, { joinColumn: "orderId" })
  order!: Order;

  @ManyToOne(() => Product, (e) => e.orderItems, { joinColumn: "productId" })
  product!: Product;

}
