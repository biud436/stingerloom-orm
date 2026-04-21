import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { TodosController } from "./todos.controller";
import { TodosService } from "./todos.service";
import { Todo } from "./todo.entity";

@Module({
  imports: [StingerloomOrmModule.forFeature([Todo])],
  controllers: [TodosController],
  providers: [TodosService],
})
export class TodosModule {}
