import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { Product } from "../generated";
import { CreateProductDto } from "./dto/create-product.dto";

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: BaseRepository<Product>,
  ) {}

  @Transactional()
  async create(dto: CreateProductDto): Promise<Product> {
    const product = new Product();
    product.name = dto.name;
    product.price = dto.price;
    product.description = dto.description ?? null;
    product.stock = dto.stock;
    product.category = dto.category;
    return this.productRepo.save(product);
  }

  async findAll(): Promise<Product[]> {
    return this.productRepo.find({});
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productRepo.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.productRepo.delete({ id });
  }
}
