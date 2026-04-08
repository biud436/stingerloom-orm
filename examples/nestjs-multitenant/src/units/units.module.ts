import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Unit } from "./unit.entity";
import { UnitsController } from "./units.controller";
import { UnitsService } from "./units.service";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Unit])],
  controllers: [UnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
