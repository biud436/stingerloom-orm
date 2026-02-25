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

  async create(dto: CreatePostDto): Promise<Post> {
    const post = new Post();
    post.title = dto.title;
    post.content = dto.content;
    if (dto.published !== undefined) post.published = dto.published;

    const result = await this.em.save(Post, post);
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Post[]> {
    const result = await this.em.find(Post, {});
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<Post> {
    const result = await this.em.findOne(Post, { where: { id } as any });
    if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
    return Array.isArray(result) ? result[0] : result;
  }

  async update(id: number, dto: UpdatePostDto): Promise<Post> {
    const result = await this.em.findOne(Post, { where: { id } as any });
    if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
    const post = Array.isArray(result) ? result[0] : result;

    if (dto.title !== undefined) post.title = dto.title;
    if (dto.content !== undefined) post.content = dto.content;
    if (dto.published !== undefined) post.published = dto.published;

    const saved = await this.em.save(Post, post);
    return Array.isArray(saved) ? saved[0] : saved;
  }

  async remove(id: number): Promise<void> {
    const result = await this.em.findOne(Post, { where: { id } as any });
    if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
    await this.em.delete(Post, { id } as any);
  }
}
