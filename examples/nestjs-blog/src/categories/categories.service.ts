import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { Category } from "./category.entity";
import {
  BaseRepository,
  Transactional,
  EntityManager,
  RawQueryBuilder,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import sql from "sql-template-tag";

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: BaseRepository<Category>,
    private readonly entityManager: EntityManager,
  ) {}

  @Transactional()
  async create(dto: CreateCategoryDto): Promise<Category> {
    const category = new Category();
    category.name = dto.name;
    if (dto.description) category.description = dto.description;

    const result = await this.categoryRepository.save(category);
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Category[]> {
    const result = await this.categoryRepository.find();
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<Category> {
    const result = await this.categoryRepository.findOne({
      where: { id },
    });

    if (!result) throw new NotFoundException(`Category with ID ${id} not found`);
    return Array.isArray(result) ? result[0] : result;
  }

  @Transactional()
  async update(id: number, dto: UpdateCategoryDto): Promise<Category> {
    const category = await this.findOne(id);

    if (dto.name !== undefined) category.name = dto.name;
    if (dto.description !== undefined) category.description = dto.description;

    const result = await this.categoryRepository.save(category);
    return Array.isArray(result) ? result[0] : result;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.categoryRepository.delete({ id });
  }

  async count(): Promise<number> {
    return this.categoryRepository.count();
  }

  /**
   * GROUP BY / HAVING demo - category별 포스트 수 집계.
   * RawQueryBuilder를 사용하여 GROUP BY + HAVING 쿼리를 실행합니다.
   */
  async getStats(): Promise<
    Array<{ name: string; postCount: number }>
  > {
    const query = RawQueryBuilder.create()
      .select(["c.name", "COUNT(p.id) as postCount"])
      .from("category", "c")
      .leftJoin("post", "p", sql`p.category_id = c.id`)
      .groupBy(["c.name"])
      .having([sql`COUNT(p.id) > 0`])
      .build();

    const result = await this.entityManager.query<
      { name: string; postCount: number }
    >(query.sql, query.values);

    if (!result) return [];
    const rows = Array.isArray(result) ? result : [result];
    return rows.map((row: any) => ({
      name: row.name,
      postCount: Number(row.postCount ?? row.postcount ?? 0),
    }));
  }
}
