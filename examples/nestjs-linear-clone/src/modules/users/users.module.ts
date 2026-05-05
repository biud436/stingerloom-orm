import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
