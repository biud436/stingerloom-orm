import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Project } from "./project.entity";
import { ProjectsService } from "./projects.service";
import { ProjectsController } from "./projects.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Project])],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
