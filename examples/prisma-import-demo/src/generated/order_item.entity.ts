import { Column, Entity, ManyToOne, PrimaryGeneratedColumn, RelationColumn, UniqueIndex, type Relation } from "@stingerloom/orm";
import { Order } from "./order.entity.js";
import { Product } from "./product.entity.js";

@Entity()
@UniqueIndex(["orderId", "productId"])
export class OrderItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  quantity!: number;

  @Column({ type: "double", precision: 10, scale: 2 })
  unitPrice!: number;

  @ManyToOne(() => Order, (e) => e.items)
  @RelationColumn({ name: "orderId" })
  order!: Relation<Order>;

  @ManyToOne(() => Product, (e) => e.orderItems)
  @RelationColumn({ name: "productId" })
  product!: Relation<Product>;
}
