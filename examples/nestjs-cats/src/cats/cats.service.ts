import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateCatDto } from "./dto/create-cat.dto";
import { UpdateCatDto } from "./dto/update-cat.dto";
import { Cat } from "./cat.entity";

import {
  BaseRepository,
  EntityManager,
  Transactional,
  CursorPaginationResult,
  BufferFlushResult,
  BufferPreviewEntry,
} from "@stingerloom/orm";
import { InjectRepository, InjectEntityManager } from "@stingerloom/orm/nestjs";
import { OwnersService } from "../owners/owners.service";
import { Owner } from "../owners/owner.entity";

@Injectable()
export class CatsService {
  constructor(
    @InjectRepository(Cat) private readonly catRepository: BaseRepository<Cat>,
    @InjectEntityManager() private readonly em: EntityManager,
    private readonly ownersService: OwnersService,
  ) {}

  async onModuleInit() {
    await this.truncateCats();
  }

  @Transactional()
  async truncateCats() {
    await this.catRepository.clear();
  }

  @Transactional()
  private async associateCatWithOwner() {
    const cat = await this.catRepository.findOne({
      where: {
        id: 1,
      },
      relations: ["owner"], // @ManyToOne eager loading demo
    });

    if (!cat) {
      return;
    }

    console.log("Cat with ID 1 already exists:", cat);

    const owner = await this.ownersService.findOne(7);

    if (!owner) {
      console.log("Owner with ID 7 not found");
      return;
    }

    cat.owner = owner;
    await this.catRepository.save(cat);
    console.log("Associated cat with owner:", cat);

    cat.owner = null;

    await this.catRepository.save(cat);
    console.log("Removed owner association from cat:", cat);
  }

  /**
   * @Transactional — create a cat within a transaction scope.
   * Automatically ROLLBACKs on error.
   */
  @Transactional()
  async create(createCatDto: CreateCatDto): Promise<Cat> {
    const cat = new Cat();
    cat.name = createCatDto.name;
    cat.age = createCatDto.age;
    cat.breed = createCatDto.breed;
    if (createCatDto.ownerId) {
      cat.ownerId = createCatDto.ownerId;
    }

    return await this.catRepository.save(cat);
  }

  /**
   * Bulk-create multiple cats in a single INSERT query (insertMany).
   */
  async bulkCreate(dtos: CreateCatDto[]): Promise<{ affected: number }> {
    const cats = dtos.map((dto) => {
      const cat = new Cat();
      cat.name = dto.name;
      cat.age = dto.age;
      cat.breed = dto.breed;
      if (dto.ownerId) {
        cat.ownerId = dto.ownerId;
      }
      return cat;
    });
    return this.catRepository.insertMany(cats);
  }

  /**
   * List excluding soft-deleted entities (default behavior — automatic deleted_at IS NULL filter).
   */
  async findAll(): Promise<Cat[]> {
    return await this.catRepository.find({
      relations: ["owner"], // @ManyToOne eager loading demo
    });
  }

  /**
   * withDeleted: true — full list including soft-deleted entities.
   */
  async findAllIncludeDeleted(): Promise<Cat[]> {
    return await this.catRepository.find({ withDeleted: true });
  }

  async findOne(id: number): Promise<Cat> {
    const result = await this.catRepository.findOne({
      where: { id },
      relations: ["owner"], // @ManyToOne eager loading demo
    });

    if (!result) {
      throw new NotFoundException(`Cat with ID ${id} not found`);
    }

    return result;
  }

  @Transactional()
  async update(id: number, updateCatDto: UpdateCatDto): Promise<Cat> {
    const cat = await this.findOne(id);

    if (updateCatDto.name !== undefined) cat.name = updateCatDto.name;
    if (updateCatDto.age !== undefined) cat.age = updateCatDto.age;
    if (updateCatDto.breed !== undefined) cat.breed = updateCatDto.breed;
    // updatedAt is refreshed automatically in the @BeforeUpdate hook

    return await this.catRepository.save(cat);
  }

  /**
   * Hard DELETE — permanently removes the row.
   */
  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.catRepository.delete({ id });
  }

  /**
   * Soft Delete — sets deleted_at to the current timestamp. Row is retained.
   * Automatically excluded from find/findOne.
   */
  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.catRepository.softDelete({ id });
  }

  /**
   * Restore — resets deleted_at to NULL on a soft-deleted entity.
   */
  async restore(id: number): Promise<void> {
    await this.catRepository.restore({ id });
  }

  /**
   * Aggregate Stats — returns count / avg / min / max in one shot.
   */
  async stats(): Promise<{
    total: number;
    avgAge: number;
    minAge: number;
    maxAge: number;
    sumAge: number;
  }> {
    const [total, avgAge, minAge, maxAge, sumAge] = await Promise.all([
      this.catRepository.count(),
      this.catRepository.avg("age"),
      this.catRepository.min("age"),
      this.catRepository.max("age"),
      this.catRepository.sum("age"),
    ]);

    return { total, avgAge, minAge, maxAge, sumAge };
  }

  /**
   * clear — removes all rows from the table (TRUNCATE).
   */
  async clear(): Promise<void> {
    await this.catRepository.clear();
  }

  /**
   * deleteMany — deletes multiple cats in a single query by ID array.
   */
  async removeMany(ids: number[]): Promise<{ affected: number }> {
    return this.catRepository.deleteMany(ids);
  }

  /**
   * List cats via cursor-based pagination.
   * Uses a cursor instead of offset, ensuring consistent performance even with large datasets.
   */
  async findWithCursor(
    take?: number,
    cursor?: string,
  ): Promise<CursorPaginationResult<Cat>> {
    return this.catRepository.findWithCursor({
      take: take ?? 10,
      cursor,
      orderBy: "id",
      direction: "ASC",
    });
  }

  // ─── Buffer Plugin Methods ────────────────────────────────────

  /**
   * Rename multiple cats atomically.
   * Loads each cat via buffer → mutates name → single flush().
   * Dirty checking: only cats whose name actually changed get UPDATEd.
   *
   * Real-world analogy: batch product rename, bulk field correction.
   */
  async bufferRename(
    updates: { id: number; name: string }[],
  ): Promise<BufferFlushResult> {
    const buf = this.em.buffer();

    for (const { id, name } of updates) {
      const cat = await buf.findOne(Cat, { where: { id } });
      if (!cat) throw new NotFoundException(`Cat #${id} not found`);
      cat.name = name;
    }

    return buf.flush();
  }

  /**
   * Mixed flush — persist new cats + update existing cats + remove one.
   * All in a single atomic transaction.
   *
   * Real-world analogy: order processing (create line items, update stock, cancel old order).
   */
  async bufferMixedFlush(
    createCats: CreateCatDto[],
    updateCats: { id: number; name?: string; age?: number; breed?: string }[],
    deleteIds: number[],
  ): Promise<BufferFlushResult> {
    const buf = this.em.buffer();

    // Queue new cat inserts
    for (const dto of createCats) {
      const cat = new Cat();
      cat.name = dto.name;
      cat.age = dto.age;
      cat.breed = dto.breed;
      buf.persist(cat);
    }

    // Load and mutate existing cats (dirty checking)
    for (const upd of updateCats) {
      const cat = await buf.findOne(Cat, { where: { id: upd.id } });
      if (!cat) throw new NotFoundException(`Cat #${upd.id} not found`);
      if (upd.name !== undefined) cat.name = upd.name;
      if (upd.age !== undefined) cat.age = upd.age;
      if (upd.breed !== undefined) cat.breed = upd.breed;
    }

    // Queue deletes
    for (const id of deleteIds) {
      const cat = await buf.findOne(Cat, { where: { id } });
      if (!cat) throw new NotFoundException(`Cat #${id} not found`);
      buf.remove(cat);
    }

    return buf.flush();
  }

  /**
   * Increment age by 1 for all cats of a given breed.
   * Dirty checking ensures only cats whose age actually changed get UPDATEd
   * (e.g. if the breed has 0 cats, flush is a no-op).
   */
  async birthday(breed: string): Promise<BufferFlushResult> {
    const buf = this.em.buffer();
    const cats = await buf.find(Cat, { where: { breed } as any });

    for (const cat of cats) {
      cat.age += 1;
    }

    return buf.flush();
  }

  /**
   * Preview what a breed rename would change — dry-run without writing to DB.
   * Returns the list of operations that flush() would execute.
   */
  async previewBreedRename(
    from: string,
    to: string,
  ): Promise<BufferPreviewEntry[]> {
    const buf = this.em.buffer();
    const cats = await buf.find(Cat, { where: { breed: from } as any });

    for (const cat of cats) {
      cat.breed = to;
    }

    return buf.preview();
  }

  /**
   * Identity map — findOne twice returns the same JS reference.
   */
  async bufferIdentityMap(id: number): Promise<{ same: boolean }> {
    const buf = this.em.buffer();

    const ref1 = await buf.findOne(Cat, { where: { id } });
    if (!ref1) throw new NotFoundException(`Cat #${id} not found`);

    const ref2 = await buf.findOne(Cat, { where: { id } });
    return { same: ref1 === ref2 };
  }

  /**
   * Entity state transitions — MANAGED after load, REMOVED after remove().
   */
  async bufferEntityState(
    id: number,
  ): Promise<{ afterLoad: string; afterRemove: string }> {
    const buf = this.em.buffer();

    const cat = await buf.findOne(Cat, { where: { id } });
    if (!cat) throw new NotFoundException(`Cat #${id} not found`);

    const afterLoad = buf.getState(cat);
    buf.remove(cat);
    const afterRemove = buf.getState(cat);

    return { afterLoad, afterRemove };
  }
}
