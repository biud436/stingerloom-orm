import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Label } from "./label.entity";
import { LabelsService } from "./labels.service";
import { LabelsController } from "./labels.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Label])],
  controllers: [LabelsController],
  providers: [LabelsService],
  exports: [LabelsService],
})
export class LabelsModule {}
