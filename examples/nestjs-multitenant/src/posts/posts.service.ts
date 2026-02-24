import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";
import { Post } from "./post.entity";
import { EntityManager } from "stingerloom-orm";

@Injectable()
export class PostsService {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  async create(tenantId: string, dto: CreatePostDto): Promise<Post> {
    return this.em.withTenant(tenantId, async (em) => {
      const post = new Post();
      post.title = dto.title;
      post.content = dto.content;
      if (dto.published !== undefined) post.published = dto.published;

      const result = await em.save(Post, post);
      return Array.isArray(result) ? result[0] : result;
    });
  }

  async findAll(tenantId: string): Promise<Post[]> {
    return this.em.withTenant(tenantId, async (em) => {
      const result = await em.find(Post, {});
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    });
  }

  async findOne(tenantId: string, id: number): Promise<Post> {
    return this.em.withTenant(tenantId, async (em) => {
      const result = await em.findOne(Post, { where: { id } as any });
      if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
      return Array.isArray(result) ? result[0] : result;
    });
  }

  async update(tenantId: string, id: number, dto: UpdatePostDto): Promise<Post> {
    return this.em.withTenant(tenantId, async (em) => {
      const result = await em.findOne(Post, { where: { id } as any });
      if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
      const post = Array.isArray(result) ? result[0] : result;

      if (dto.title !== undefined) post.title = dto.title;
      if (dto.content !== undefined) post.content = dto.content;
      if (dto.published !== undefined) post.published = dto.published;

      const saved = await em.save(Post, post);
      return Array.isArray(saved) ? saved[0] : saved;
    });
  }

  async remove(tenantId: string, id: number): Promise<void> {
    await this.em.withTenant(tenantId, async (em) => {
      const result = await em.findOne(Post, { where: { id } as any });
      if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
      await em.delete(Post, { id } as any);
    });
  }
}
