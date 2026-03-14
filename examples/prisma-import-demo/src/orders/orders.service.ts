import { Injectable, NotFoundException } from "@nestjs/common";
import { Transactional } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository } from "@stingerloom/orm";
import { Order, OrderItem } from "../generated";
import { CreateOrderDto } from "./dto/create-order.dto";

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: BaseRepository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: BaseRepository<OrderItem>,
  ) {}

  @Transactional()
  async create(dto: CreateOrderDto): Promise<Order> {
    const totalAmount = dto.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );

    const order = new Order();
    (order as any).customerId = dto.customerId;
    order.totalAmount = totalAmount;
    order.status = "PENDING";
    const savedOrder = await this.orderRepo.save(order);

    for (const item of dto.items) {
      const orderItem = new OrderItem();
      (orderItem as any).orderId = savedOrder.id;
      (orderItem as any).productId = item.productId;
      orderItem.quantity = item.quantity;
      orderItem.unitPrice = item.unitPrice;
      await this.orderItemRepo.save(orderItem);
    }

    return this.findOne(savedOrder.id);
  }

  async findAll(): Promise<Order[]> {
    return this.orderRepo.find({
      relations: ["customer", "items"],
    });
  }

  async findOne(id: number): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: ["customer", "items"],
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  @Transactional()
  async remove(id: number): Promise<void> {
    await this.findOne(id);
    // Delete order items first (FK constraint)
    await this.orderItemRepo.delete({ orderId: id } as any);
    await this.orderRepo.delete({ id });
  }
}
