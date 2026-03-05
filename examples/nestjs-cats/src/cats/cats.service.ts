import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateCatDto } from "./dto/create-cat.dto";
import { UpdateCatDto } from "./dto/update-cat.dto";
import { Cat } from "./cat.entity";

import {
  BaseRepository,
  Transactional,
  CursorPaginationResult,
} from "@stingerloom/orm";
import { InjectRepository } from "src/stingerloom-orm/inject-repository.decorator";
import { OwnersService } from "src/owners/owners.service";

@Injectable()
export class CatsService {
  constructor(
    @InjectRepository(Cat) private readonly catRepository: BaseRepository<Cat>,
    private readonly ownersService: OwnersService,
  ) {}

  async onModuleInit() {
    await this.associateCatWithOwner();
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

    const onwer = await this.ownersService.findOne(7);

    if (!onwer) {
      console.log("Owner with ID 7 not found");
      return;
    }

    cat.owner = onwer;
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

    const result = await this.catRepository.save(cat);
    if (!result) {
      throw new Error("Failed to create cat");
    }
    return Array.isArray(result) ? result[0] : result;
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
    const result = await this.catRepository.find({
      relations: ["owner"], // @ManyToOne eager 로딩 데모
    });
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  /**
   * withDeleted: true — soft-deleted 엔티티 포함 전체 조회.
   */
  async findAllIncludeDeleted(): Promise<Cat[]> {
    const result = await this.catRepository.find({ withDeleted: true } as any);
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<Cat> {
    const result = await this.catRepository.findOne({
      where: { id } as any,
      relations: ["owner"], // @ManyToOne eager 로딩 데모
    });

    if (!result) {
      throw new NotFoundException(`Cat with ID ${id} not found`);
    }

    const cat = Array.isArray(result) ? result[0] : result;
    if (!cat) {
      throw new NotFoundException(`Cat with ID ${id} not found`);
    }
    return cat;
  }

  @Transactional()
  async update(id: number, updateCatDto: UpdateCatDto): Promise<Cat> {
    const cat = await this.findOne(id);

    if (updateCatDto.name !== undefined) cat.name = updateCatDto.name;
    if (updateCatDto.age !== undefined) cat.age = updateCatDto.age;
    if (updateCatDto.breed !== undefined) cat.breed = updateCatDto.breed;
    // updatedAt은 @BeforeUpdate 훅에서 자동 갱신됨

    const result = await this.catRepository.save(cat);
    if (!result) {
      throw new Error("Failed to update cat");
    }
    return Array.isArray(result) ? result[0] : result;
  }

  /**
   * 실제 DELETE — 행을 영구 삭제합니다.
   */
  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.catRepository.delete({ id } as any);
  }

  /**
   * Soft Delete — deleted_at을 현재 시각으로 설정. 행은 유지.
   * find/findOne에서 자동으로 제외됩니다.
   */
  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.catRepository.softDelete({ id } as any);
  }

  /**
   * Restore — soft-deleted 엔티티의 deleted_at을 NULL로 복원.
   */
  async restore(id: number): Promise<void> {
    await this.catRepository.restore({ id } as any);
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
}
