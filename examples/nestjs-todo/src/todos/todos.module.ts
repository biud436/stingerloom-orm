import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "../stingerloom-orm/stingerloom-orm.module";
import { TodosController } from "./todos.controller";
import { TodosService } from "./todos.service";
import { Todo } from "./todo.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Todo])],
  controllers: [TodosController],
  providers: [TodosService],
})
export class TodosModule {}
