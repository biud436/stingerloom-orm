import { Module, forwardRef } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { BulkOperation } from "./bulk-operation.entity";
import { BulkOperationsService } from "./bulk-operations.service";
import { BulkOperationsController } from "./bulk-operations.controller";
import { IssuesModule } from "../issues/issues.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([BulkOperation]),
    forwardRef(() => IssuesModule),
  ],
  controllers: [BulkOperationsController],
  providers: [BulkOperationsService],
  exports: [BulkOperationsService],
})
export class BulkOperationsModule {}
