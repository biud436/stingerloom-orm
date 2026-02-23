import { Injectable, NotFoundException } from "@nestjs/common";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";
import { Post } from "./post.entity";
import {
  BaseRepository,
  Transactional,
  CursorPaginationResult,
  ExplainResult,
  SchemaDiff,
  SchemaDiffMigrationGenerator,
} from "stingerloom-orm";
import { InjectRepository } from "src/stingerloom-orm/inject-repository.decorator";

@Injectable()
export class PostsService {
  constructor(
    @InjectRepository(Post)
    private readonly postRepository: BaseRepository<Post>,
  ) {}

  @Transactional()
  async create(dto: CreatePostDto): Promise<Post> {
    const post = new Post();
    post.title = dto.title;
    post.slug = dto.slug;
    post.content = dto.content;

    const result = await this.postRepository.save(post);
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Post[]> {
    const result = await this.postRepository.find({ cache: 5000 } as any);
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findAllIncludeDeleted(): Promise<Post[]> {
    const result = await this.postRepository.find({ withDeleted: true } as any);
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<Post> {
    const result = await this.postRepository.findOne({
      where: { id } as any,
    });

    if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
    const post = Array.isArray(result) ? result[0] : result;
    if (!post) throw new NotFoundException(`Post with ID ${id} not found`);
    return post;
  }

  @Transactional()
  async update(id: number, dto: UpdatePostDto): Promise<Post> {
    const post = await this.findOne(id);

    if (dto.title !== undefined) post.title = dto.title;
    if (dto.slug !== undefined) post.slug = dto.slug;
    if (dto.content !== undefined) post.content = dto.content;

    const result = await this.postRepository.save(post);
    return Array.isArray(result) ? result[0] : result;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.postRepository.delete({ id } as any);
  }

  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.postRepository.softDelete({ id } as any);
  }

  async restore(id: number): Promise<void> {
    await this.postRepository.restore({ id } as any);
  }

  async count(): Promise<number> {
    return this.postRepository.count();
  }

  /**
   * findAndCount — 페이지네이션 메타데이터 반환 (total count 포함).
   */
  async findPaginated(
    page = 1,
    limit = 10,
  ): Promise<{ data: Post[]; total: number; page: number; totalPages: number }> {
    const [data, total] = await this.postRepository.findAndCount({
      take: limit,
      skip: (page - 1) * limit,
    } as any);
    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * upsert — slug 기준으로 존재하면 업데이트, 없으면 삽입.
   */
  async upsertBySlug(dto: CreatePostDto): Promise<{ message: string }> {
    const post = new Post();
    post.title = dto.title;
    post.slug = dto.slug;
    post.content = dto.content;
    await this.postRepository.upsert(post, ["slug"]);
    return { message: `Post upserted: ${dto.slug}` };
  }

  /**
   * explain — 쿼리 실행 계획 조회.
   */
  async explainQuery(id: number): Promise<ExplainResult> {
    return this.postRepository.explain({ where: { id } } as any);
  }

  /**
   * schemaDiff — 현재 엔티티와 DB 스키마 차이 반환.
   */
  async getSchemaDiff(): Promise<object> {
    const diff = new SchemaDiff();
    // 드라이버/DB 연결 없이 엔티티 메타데이터 기반 DDL만 반환
    return { message: "SchemaDiff available — connect driver to compare with DB", diff };
  }

  /**
   * generateMigration — Schema Diff 기반 Migration 파일 생성.
   */
  async generateMigration(): Promise<{ content: string }> {
    const generator = new SchemaDiffMigrationGenerator();
    const content = generator.generate(
      { addTables: [], dropTables: [], addColumns: [], dropColumns: [], alterColumns: [] },
      "mysql",
    );
    return { content };
  }

  async findWithCursor(
    take?: number,
    cursor?: string,
  ): Promise<CursorPaginationResult<Post>> {
    return this.postRepository.findWithCursor({
      take: take ?? 10,
      cursor,
      orderBy: "id",
      direction: "ASC",
    });
  }
}
