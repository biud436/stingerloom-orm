import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { Category } from "./category.entity";
import { Post } from "../posts/post.entity";
import { BaseRepository, Transactional, qAlias } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: BaseRepository<Category>,
  ) {}

  @Transactional()
  async create(dto: CreateCategoryDto): Promise<Category> {
    const category = new Category();
    category.name = dto.name;
    if (dto.description) category.description = dto.description;

    return await this.categoryRepository.save(category);
  }

  async findAll(): Promise<Category[]> {
    return await this.categoryRepository.find();
  }

  async findOne(id: number): Promise<Category> {
    const result = await this.categoryRepository.findOne({
      where: { id },
    });

    if (!result) throw new NotFoundException(`Category with ID ${id} not found`);
    return result;
  }

  @Transactional()
  async update(id: number, dto: UpdateCategoryDto): Promise<Category> {
    const category = await this.findOne(id);

    if (dto.name !== undefined) category.name = dto.name;
    if (dto.description !== undefined) category.description = dto.description;

    return await this.categoryRepository.save(category);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.categoryRepository.delete({ id });
  }

  async count(): Promise<number> {
    return this.categoryRepository.count();
  }

  /**
   * GROUP BY / HAVING demo — aggregates post count per category.
   *
   * Written against the typed QueryDSL rather than raw SQL: `leftJoinRelation`
   * derives the ON clause from the @OneToMany metadata, `qAlias` resolves
   * property names through the NamingStrategy, and `coerce` normalizes the
   * driver's aggregate type — so there is no hardcoded table name, no
   * `category_id` literal, and no `postCount ?? postcount` casing fallback.
   */
  async getStats(): Promise<Array<{ name: string; postCount: number }>> {
    const c = qAlias(Category, "c");
    const p = qAlias(Post, "p");
    const postCount = p.id.count();

    return await this.categoryRepository
      .createQueryBuilder("c")
      .leftJoinRelation("posts", "p")
      .select([c.name.as("name"), postCount.as("postCount")])
      // Group by the PK too so two categories sharing a name stay separate
      // groups and PostgreSQL's strict GROUP BY accepts the projected name.
      .groupBy([c.id, c.name])
      .having(postCount.gt(0))
      .getRawMany<{ name: string; postCount: number }>({
        coerce: { postCount: "number" },
      });
  }
}
