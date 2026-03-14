import { Injectable, NotFoundException } from "@nestjs/common";
import { EntityManager, BaseRepository } from "@stingerloom/orm";
import { Todo } from "./todo.entity";
import { CreateTodoDto } from "./dto/create-todo.dto";
import { UpdateTodoDto } from "./dto/update-todo.dto";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Inject } from "@nestjs/common";

@Injectable()
export class TodosService {
  constructor(
    @InjectRepository(Todo)
    private readonly todoRepository: BaseRepository<Todo>,
  ) {}

  async create(dto: CreateTodoDto): Promise<Todo> {
    const todo = new Todo();
    todo.title = dto.title;
    todo.description = dto.description ?? null;
    todo.completed = dto.completed ?? false;

    return await this.todoRepository.save(todo);
  }

  async findAll(): Promise<Todo[]> {
    return await this.todoRepository.find({});
  }

  async findOne(id: number): Promise<Todo> {
    const result = await this.todoRepository.findOne({ where: { id } });
    if (!result) throw new NotFoundException(`Todo #${id} not found`);
    return result;
  }

  async update(id: number, dto: UpdateTodoDto): Promise<Todo> {
    const todo = await this.findOne(id);
    if (dto.title !== undefined) todo.title = dto.title;
    if (dto.description !== undefined) todo.description = dto.description;
    if (dto.completed !== undefined) todo.completed = dto.completed;

    return await this.todoRepository.save(todo);
  }

  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.todoRepository.softDelete({ id });
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.todoRepository.delete({ id });
  }
}
