import { Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { CreateOwnerDto } from "./dto/create-owner.dto";
import { Owner } from "./owner.entity";

import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";

@Injectable()
export class OwnersService implements OnModuleInit {
  constructor(
    @InjectRepository(Owner)
    private readonly ownerRepository: BaseRepository<Owner>,
  ) {}

  async onModuleInit() {
    await this.truncateOwners();
  }

  async truncateOwners() {
    await this.ownerRepository.clear();
  }

  @Transactional()
  async create(dto: CreateOwnerDto): Promise<Owner> {
    const owner = new Owner();
    owner.name = dto.name;
    owner.email = dto.email;
    // createdAt is set automatically in the @BeforeInsert hook

    return await this.ownerRepository.save(owner);
  }

  async findAll(): Promise<Owner[]> {
    return await this.ownerRepository.find();
  }

  async findOne(id: number): Promise<Owner> {
    const result = await this.ownerRepository.findOne({
      where: { id },
    });

    if (!result) throw new NotFoundException(`Owner with ID ${id} not found`);
    return result;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.ownerRepository.delete({ id });
  }

  /**
   * Per-owner cat count statistics — demo using count().
   */
  async count(): Promise<number> {
    return this.ownerRepository.count();
  }
}
