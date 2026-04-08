import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Unit } from "./unit.entity";
import { UnitsService } from "./units.service";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Unit])],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
