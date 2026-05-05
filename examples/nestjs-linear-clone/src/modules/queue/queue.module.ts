import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { QueueService } from "./queue.service";
import { QueueController } from "./queue.controller";
import { ActivityModule } from "../activity/activity.module";
import { Issue } from "../issues/issue.entity";

@Module({
  imports: [StingerloomOrmModule.forFeature([Issue]), ActivityModule],
  controllers: [QueueController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
