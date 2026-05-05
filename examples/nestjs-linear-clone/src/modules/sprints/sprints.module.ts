import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Sprint } from "./sprint.entity";
import { SprintsService } from "./sprints.service";
import { SprintsController } from "./sprints.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Sprint])],
  controllers: [SprintsController],
  providers: [SprintsService],
  exports: [SprintsService],
})
export class SprintsModule {}
