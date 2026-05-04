import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Membership } from "./membership.entity";
import { MembershipsService } from "./memberships.service";
import { MembershipsController } from "./memberships.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Membership])],
  controllers: [MembershipsController],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
