import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { Customer } from "../generated";
import { CreateCustomerDto } from "./dto/create-customer.dto";

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private readonly customerRepo: BaseRepository<Customer>,
  ) {}

  @Transactional()
  async create(dto: CreateCustomerDto): Promise<Customer> {
    const customer = new Customer();
    customer.email = dto.email;
    customer.name = dto.name;
    return this.customerRepo.save(customer);
  }

  async findAll(): Promise<Customer[]> {
    return this.customerRepo.find({});
  }

  async findOne(id: number): Promise<Customer> {
    const customer = await this.customerRepo.findOne({
      where: { id },
      relations: ["orders"],
    });
    if (!customer) {
      throw new NotFoundException(`Customer #${id} not found`);
    }
    return customer;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.customerRepo.delete({ id });
  }
}
