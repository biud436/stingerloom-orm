import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Unit } from "./unit.entity";
import { BaseRepository, MetadataContext, qAlias } from "@stingerloom/orm";
import { CreateUnitDto } from "./dto/create-unit.dto";
import { OnModuleInit } from "@nestjs/common";
import { TenantSchemaService } from "../tenant";

@Injectable()
export class UnitsService implements OnModuleInit {
  constructor(
    @InjectRepository(Unit)
    private readonly unitRepository: BaseRepository<Unit>,
    private readonly tenantSchemaService: TenantSchemaService,
  ) {}

  async onModuleInit() {
    const tenantId = "my_tenant_";
    MetadataContext.run(tenantId, async () => {
      await this.tenantSchemaService.ensureSchema(tenantId);

      const unitCount = await this.unitRepository.count();

      if (unitCount === 0) {
        const defaultUnits = [
          { unitNumber: "Unit 101" },
          { unitNumber: "Unit 102" },
          { unitNumber: "Unit 103" },
        ];

        await this.unitRepository.saveMany(defaultUnits);
      }
    });
  }

  async create(createUnitDto: CreateUnitDto): Promise<Unit> {
    const unit = this.unitRepository.save(createUnitDto);

    return unit;
  }
}
