import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
