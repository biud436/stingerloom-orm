import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Unit } from "./unit.entity";
import { BaseRepository, qAlias } from "@stingerloom/orm";
import { CreateUnitDto } from "./dto/create-unit.dto";

@Injectable()
export class UnitsService {
  constructor(
    @InjectRepository(Unit)
    private readonly unitRepository: BaseRepository<Unit>,
  ) {}

  async create(createUnitDto: CreateUnitDto): Promise<Unit> {
    const unit = this.unitRepository.save(createUnitDto);

    return unit;
  }
}
