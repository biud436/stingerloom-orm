import { Module } from "@nestjs/common";
import { OwnersService } from "./owners.service";
import { OwnersController } from "./owners.controller";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Owner } from "./owner.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Owner])],
  controllers: [OwnersController],
  providers: [OwnersService],
  exports: [OwnersService],
})
export class OwnersModule {}
