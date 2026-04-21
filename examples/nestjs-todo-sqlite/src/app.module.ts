import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StingerloomOrmModule } from '@stingerloom/orm/nestjs';
import { TodosModule } from './todos/todos.module';
import { Todo } from './todos/todo.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StingerloomOrmModule.forRoot({
      type: 'sqlite',
      database: process.env.DB_PATH || 'todo.db',
      entities: [Todo],
      synchronize: true,
      logging: true,
    }),
    TodosModule,
  ],
})
export class AppModule {}
