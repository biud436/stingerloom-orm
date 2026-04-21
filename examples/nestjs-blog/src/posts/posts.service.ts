import { Injectable, NotFoundException } from "@nestjs/common";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";
import { Post } from "./post.entity";
import { Tag } from "../tags/tag.entity";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  CursorPaginationResult,
  PagePaginationResult,
  ExplainResult,
  SchemaDiff,
  SchemaDiffMigrationGenerator,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Inject } from "@nestjs/common";

@Injectable()
export class PostsService {
  constructor(
    @InjectRepository(Post)
    private readonly postRepository: BaseRepository<Post>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async create(dto: CreatePostDto): Promise<Post> {
    const post = new Post();
    post.title = dto.title;
    post.slug = dto.slug;
    post.content = dto.content;
    if (dto.authorId) post.authorId = dto.authorId;
    if (dto.categoryId) post.categoryId = dto.categoryId;

    return await this.postRepository.save(post);
  }

  async findAll(): Promise<Post[]> {
    return await this.postRepository.find({});
  }

  async findAllIncludeDeleted(): Promise<Post[]> {
    return await this.postRepository.find({ withDeleted: true });
  }

  async findOne(id: number): Promise<Post> {
    const result = await this.postRepository.findOne({
      where: { id },
    });

    if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
    return result;
  }

  @Transactional()
  async update(id: number, dto: UpdatePostDto): Promise<Post> {
    const post = await this.findOne(id);

    if (dto.title !== undefined) post.title = dto.title;
    if (dto.slug !== undefined) post.slug = dto.slug;
    if (dto.content !== undefined) post.content = dto.content;

    return await this.postRepository.save(post);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.postRepository.delete({ id });
  }

  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.postRepository.softDelete({ id });
  }

  async restore(id: number): Promise<void> {
    await this.postRepository.restore({ id });
  }

  async count(): Promise<number> {
    return this.postRepository.count();
  }

  /**
   * findWithPage — offset-based page pagination.
   */
  async findPaginated(
    page = 1,
    limit = 10,
  ): Promise<PagePaginationResult<Post>> {
    return this.postRepository.findWithPage({ page, pageSize: limit });
  }

  /**
   * upsert — updates if a row exists by slug, otherwise inserts.
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
   * explain — retrieves the query execution plan.
   */
  async explainQuery(id: number): Promise<ExplainResult> {
    return this.postRepository.explain({ where: { id } });
  }

  /**
   * schemaDiff — returns the diff between current entity metadata and the DB schema.
   */
  async getSchemaDiff(): Promise<object> {
    const diff = new SchemaDiff();
    // Return DDL derived from entity metadata only, without a driver/DB connection
    return { message: "SchemaDiff available — connect driver to compare with DB", diff };
  }

  /**
   * generateMigration — generates a Migration file from the Schema Diff.
   */
  async generateMigration(): Promise<{ content: string }> {
    const generator = new SchemaDiffMigrationGenerator();
    const content = generator.generate(
      { addTables: [], dropTables: [], addColumns: [], dropColumns: [], alterColumns: [] },
      "mysql",
    );
    return { content };
  }

  /**
   * addTagToPost — inserts a (postId, tagId) row into the join table (post_tags).
   */
  async addTagToPost(
    postId: number,
    tagId: number,
  ): Promise<{ message: string }> {
    await this.em.query(
      "INSERT IGNORE INTO `post_tags` (`post_id`, `tag_id`) VALUES (?, ?)",
      [postId, tagId],
    );
    return { message: `Tag ${tagId} added to Post ${postId}` };
  }

  /**
   * removeTagFromPost — deletes a (postId, tagId) row from the join table.
   */
  async removeTagFromPost(
    postId: number,
    tagId: number,
  ): Promise<{ message: string }> {
    await this.em.query(
      "DELETE FROM `post_tags` WHERE `post_id` = ? AND `tag_id` = ?",
      [postId, tagId],
    );
    return { message: `Tag ${tagId} removed from Post ${postId}` };
  }

  /**
   * getPostTags — returns the Post's associated Tags via relations loading.
   */
  async getPostTags(postId: number): Promise<Tag[]> {
    const result = await this.postRepository.findOne({
      where: { id: postId },
      relations: ["tags"],
    });
    if (!result) throw new NotFoundException(`Post with ID ${postId} not found`);
    return result.tags ?? [];
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
