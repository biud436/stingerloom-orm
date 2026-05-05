import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { SavedFilter } from "./saved-filter.entity";
import { SavedFiltersService } from "./saved-filters.service";
import { SavedFiltersController } from "./saved-filters.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([SavedFilter])],
  controllers: [SavedFiltersController],
  providers: [SavedFiltersService],
  exports: [SavedFiltersService],
})
export class SavedFiltersModule {}
