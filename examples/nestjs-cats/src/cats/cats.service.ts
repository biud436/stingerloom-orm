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
  EntityState,
} from "@stingerloom/orm";
import { InjectRepository, InjectEntityManager } from "@stingerloom/orm/nestjs";
import { OwnersService } from "src/owners/owners.service";
import { Owner } from "src/owners/owner.entity";

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
      relations: ["owner"], // @ManyToOne eager 로딩 데모
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
   * @Transactional — 트랜잭션 범위 내에서 고양이를 생성합니다.
   * 오류 시 자동 ROLLBACK.
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
   * 여러 고양이를 한 번의 INSERT 쿼리로 일괄 생성합니다 (insertMany).
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
   * soft-deleted 엔티티 제외한 목록 조회 (기본 동작 — deleted_at IS NULL 자동 필터).
   */
  async findAll(): Promise<Cat[]> {
    return await this.catRepository.find({
      relations: ["owner"], // @ManyToOne eager 로딩 데모
    });
  }

  /**
   * withDeleted: true — soft-deleted 엔티티 포함 전체 조회.
   */
  async findAllIncludeDeleted(): Promise<Cat[]> {
    return await this.catRepository.find({ withDeleted: true });
  }

  async findOne(id: number): Promise<Cat> {
    const result = await this.catRepository.findOne({
      where: { id },
      relations: ["owner"], // @ManyToOne eager 로딩 데모
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
    // updatedAt은 @BeforeUpdate 훅에서 자동 갱신됨

    return await this.catRepository.save(cat);
  }

  /**
   * 실제 DELETE — 행을 영구 삭제합니다.
   */
  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.catRepository.delete({ id });
  }

  /**
   * Soft Delete — deleted_at을 현재 시각으로 설정. 행은 유지.
   * find/findOne에서 자동으로 제외됩니다.
   */
  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.catRepository.softDelete({ id });
  }

  /**
   * Restore — soft-deleted 엔티티의 deleted_at을 NULL로 복원.
   */
  async restore(id: number): Promise<void> {
    await this.catRepository.restore({ id });
  }

  /**
   * Aggregate Stats — count / avg / min / max를 한 번에 반환합니다.
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
   * clear — 테이블의 모든 데이터를 제거합니다 (TRUNCATE).
   */
  async clear(): Promise<void> {
    await this.catRepository.clear();
  }

  /**
   * deleteMany — ID 배열로 여러 고양이를 한 번의 쿼리로 삭제합니다.
   */
  async removeMany(ids: number[]): Promise<{ affected: number }> {
    return this.catRepository.deleteMany(ids);
  }

  /**
   * 커서 기반 페이지네이션으로 고양이 목록을 조회합니다.
   * offset 방식 대신 커서를 사용하여 대량 데이터에서도 일정한 성능을 보장합니다.
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
   * Batch update cats via dirty checking — load, mutate, flush.
   */
  async bufferBatchUpdate(
    updates: { id: number; name?: string; age?: number; breed?: string }[],
  ): Promise<BufferFlushResult> {
    const buf = this.em.buffer();

    for (const upd of updates) {
      const cat = await buf.findOne(Cat, { where: { id: upd.id } });
      if (!cat) throw new NotFoundException(`Cat #${upd.id} not found`);
      if (upd.name !== undefined) cat.name = upd.name;
      if (upd.age !== undefined) cat.age = upd.age;
      if (upd.breed !== undefined) cat.breed = upd.breed;
    }

    return buf.flush();
  }

  /**
   * Mixed flush — create + update + delete in a single flush.
   */
  async bufferMixedFlush(
    createDto: CreateCatDto,
    updateId: number,
    updateDto: UpdateCatDto,
    deleteId: number,
  ): Promise<BufferFlushResult> {
    const buf = this.em.buffer();

    // persist new cat
    const newCat = new Cat();
    newCat.name = createDto.name;
    newCat.age = createDto.age;
    newCat.breed = createDto.breed;
    buf.persist(newCat);

    // load and mutate existing cat
    const existing = await buf.findOne(Cat, { where: { id: updateId } });
    if (!existing) throw new NotFoundException(`Cat #${updateId} not found`);
    if (updateDto.name !== undefined) existing.name = updateDto.name;
    if (updateDto.age !== undefined) existing.age = updateDto.age;
    if (updateDto.breed !== undefined) existing.breed = updateDto.breed;

    // mark for deletion
    const toDelete = await buf.findOne(Cat, { where: { id: deleteId } });
    if (!toDelete) throw new NotFoundException(`Cat #${deleteId} not found`);
    buf.remove(toDelete);

    return buf.flush();
  }

  /**
   * Preview — dry-run showing what flush would do, without writing to DB.
   */
  async bufferPreview(
    ids: number[],
    updates: { name?: string; age?: number; breed?: string },
  ): Promise<BufferPreviewEntry[]> {
    const buf = this.em.buffer();

    for (const id of ids) {
      const cat = await buf.findOne(Cat, { where: { id } });
      if (!cat) throw new NotFoundException(`Cat #${id} not found`);
      if (updates.name !== undefined) cat.name = updates.name;
      if (updates.age !== undefined) cat.age = updates.age;
      if (updates.breed !== undefined) cat.breed = updates.breed;
    }

    return buf.preview();
  }

  /**
   * Identity map — findOne twice returns the same reference.
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

  /**
   * Buffer with owner FK — create owner via repo, then persist cat via buffer.
   */
  async bufferWithOwner(
    ownerData: { name: string; email: string },
    catData: CreateCatDto,
  ): Promise<BufferFlushResult> {
    // Create owner via repository (outside buffer)
    const owner = new Owner();
    owner.name = ownerData.name;
    owner.email = ownerData.email;
    const savedOwner = await this.em.save(Owner, owner);

    // Persist cat via buffer with owner FK
    const buf = this.em.buffer();
    const cat = new Cat();
    cat.name = catData.name;
    cat.age = catData.age;
    cat.breed = catData.breed;
    cat.ownerId = savedOwner.id;
    buf.persist(cat);

    return buf.flush();
  }
}
