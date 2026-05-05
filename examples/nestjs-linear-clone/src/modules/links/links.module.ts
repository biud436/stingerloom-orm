import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { IssueLink } from "./link.entity";
import { LinksService } from "./links.service";
import { LinksController } from "./links.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([IssueLink])],
  controllers: [LinksController],
  providers: [LinksService],
  exports: [LinksService],
})
export class LinksModule {}
