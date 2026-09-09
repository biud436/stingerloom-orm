import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Unit } from "./unit.entity";
import { BaseRepository, qAlias } from "@stingerloom/orm";
import { CreateUnitDto } from "./dto/create-unit.dto";

@Injectable()
export class UnitsService implements OnModuleInit {
  constructor(
    @InjectRepository(Unit)
    private readonly unitRepository: BaseRepository<Unit>,
  ) {}

  /**
   * `Unit` is pinned to the "public" schema (see unit.entity.ts), so there is
   * one row set for every tenant. Seed it once, outside any tenant context —
   * a request under `x-tenant-id: tenant_a` reads these same rows.
   */
  async onModuleInit() {
    const unitCount = await this.unitRepository.count();

    if (unitCount === 0) {
      await this.unitRepository.saveMany([
        { unitNumber: "Unit 101" },
        { unitNumber: "Unit 102" },
        { unitNumber: "Unit 103" },
      ]);
    }
  }

  async create(createUnitDto: CreateUnitDto): Promise<Unit> {
    const unit = this.unitRepository.save(createUnitDto);

    return unit;
  }

  async findInActiveUnits(): Promise<Unit[]> {
    const unit = qAlias(Unit, "u");

    // Runs as `SELECT ... FROM "public"."unit" u` even inside a tenant
    // request — the pin wins over the tenant strategy.
    const items = await this.unitRepository
      .createQueryBuilder(unit)
      .where(unit.active.isNull())
      .orWhere(unit.active.eq(false))
      .getMany();

    return items;
  }
}
