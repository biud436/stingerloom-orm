import { Injectable, NotFoundException } from "@nestjs/common";
import { EntityManager, BaseRepository, BufferFlushResult } from "@stingerloom/orm";
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
   * Batch complete multiple todos using the Buffer Plugin.
   *
   * Demonstrates: buf.findOne() auto-tracks, then flush() in a single transaction.
   */
  async batchComplete(dto: BatchCompleteDto): Promise<BufferFlushResult> {
    const buf = this.em.buffer();

    // Load and auto-track each todo (mut.findOne = em.findOne + track)
    for (const id of dto.ids) {
      const todo = await buf.findOne(Todo, { where: { id } });
      if (!todo) throw new NotFoundException(`Todo #${id} not found`);
      todo.completed = true;
    }

    // Flush all updates atomically (BEGIN → UPDATE × N → COMMIT)
    return buf.flush();
  }
}
