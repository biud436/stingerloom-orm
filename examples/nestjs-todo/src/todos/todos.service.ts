import { Injectable, NotFoundException } from "@nestjs/common";
import { EntityManager, BaseRepository, MutationFlushResult } from "@stingerloom/orm";
import { Todo } from "./todo.entity";
import { CreateTodoDto } from "./dto/create-todo.dto";
import { UpdateTodoDto } from "./dto/update-todo.dto";
import { BatchCompleteDto } from "./dto/batch-complete.dto";
import { InjectRepository, InjectEntityManager } from "@stingerloom/orm/nestjs";

@Injectable()
export class TodosService {
  constructor(
    @InjectRepository(Todo)
    private readonly todoRepository: BaseRepository<Todo>,
    @InjectEntityManager()
    private readonly em: EntityManager,
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

  /**
   * Batch complete multiple todos using the Mutation Plugin.
   *
   * Demonstrates: track() → modify → flush() in a single transaction.
   */
  async batchComplete(dto: BatchCompleteDto): Promise<MutationFlushResult> {
    const mut = (this.em as any).mutate();

    // Load and track each todo
    for (const id of dto.ids) {
      const todo = await this.findOne(id); // throws 404 if not found
      mut.track(todo);
      todo.completed = true;
    }

    // Flush all updates atomically (BEGIN → UPDATE × N → COMMIT)
    return mut.flush();
  }
}
