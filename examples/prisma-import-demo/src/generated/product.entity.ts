import { Column, CreateTimestamp, Entity, OneToMany, PrimaryGeneratedColumn } from "@stingerloom/orm";
import { OrderItem } from "./order_item.entity";
import { Category } from "./category.enum";

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ type: "double", precision: 10, scale: 2 })
  price!: number;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ default: 0 })
  stock!: number;

  @Column({ type: "enum", enumName: "Category", enumValues: ["ELECTRONICS", "CLOTHING", "FOOD", "BOOKS", "TOYS"] })
  category!: string;

  @CreateTimestamp()
  createdAt!: Date;

  @OneToMany(() => OrderItem, { mappedBy: "product" })
  orderItems!: OrderItem[];
}
