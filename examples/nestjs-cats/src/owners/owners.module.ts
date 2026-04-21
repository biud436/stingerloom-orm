import { Module } from "@nestjs/common";
import { OwnersService } from "./owners.service";
import { OwnersController } from "./owners.controller";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Owner } from "./owner.entity";

@Module({
  imports: [StingerloomOrmModule.forFeature([Owner])],
  controllers: [OwnersController],
  providers: [OwnersService],
  exports: [OwnersService],
})
export class OwnersModule {}
