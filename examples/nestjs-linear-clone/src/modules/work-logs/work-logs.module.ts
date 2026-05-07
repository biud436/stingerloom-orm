import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { WorkLog } from "./work-log.entity";
import { Issue } from "../issues/issue.entity";
import { WorkLogsService } from "./work-logs.service";
import { WorkLogsController } from "./work-logs.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([WorkLog, Issue])],
  controllers: [WorkLogsController],
  providers: [WorkLogsService],
  exports: [WorkLogsService],
})
export class WorkLogsModule {}
