import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { ActivityLog } from "./activity-log.entity";
import { ActivityService } from "./activity.service";
import { ActivityController } from "./activity.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([ActivityLog])],
  controllers: [ActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
