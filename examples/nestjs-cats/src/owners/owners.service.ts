import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateOwnerDto } from "./dto/create-owner.dto";
import { Owner } from "./owner.entity";

import { BaseRepository, Transactional } from "stingerloom-orm";
import { InjectRepository } from "src/stingerloom-orm/inject-repository.decorator";

@Injectable()
export class OwnersService {
  constructor(
    @InjectRepository(Owner)
    private readonly ownerRepository: BaseRepository<Owner>,
  ) {}

  @Transactional()
  async create(dto: CreateOwnerDto): Promise<Owner> {
    const owner = new Owner();
    owner.name = dto.name;
    owner.email = dto.email;
    // createdAt은 @BeforeInsert 훅에서 자동 설정

    const result = await this.ownerRepository.save(owner);
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Owner[]> {
    const result = await this.ownerRepository.find();
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<Owner> {
    const result = await this.ownerRepository.findOne({
      where: { id } as any,
    });

    if (!result) throw new NotFoundException(`Owner with ID ${id} not found`);
    return Array.isArray(result) ? result[0] : result;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.ownerRepository.delete({ id } as any);
  }

  /**
   * 주인별 고양이 수 통계 — count 활용 데모.
   */
  async count(): Promise<number> {
    return this.ownerRepository.count();
  }
}
