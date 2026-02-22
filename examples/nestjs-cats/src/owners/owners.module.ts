import { Module } from "@nestjs/common";
import { OwnersService } from "./owners.service";
import { OwnersController } from "./owners.controller";
import { StinglerloomOrmModule } from "src/stingerloom-orm/stingerloom-orm.module";
import { Owner } from "./owner.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Owner])],
  controllers: [OwnersController],
  providers: [OwnersService],
  exports: [OwnersService],
})
export class OwnersModule {}
