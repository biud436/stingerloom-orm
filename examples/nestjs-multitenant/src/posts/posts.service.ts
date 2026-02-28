import { Injectable, NotFoundException } from "@nestjs/common";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";
import { Post } from "./post.entity";
import { BaseRepository } from "@stingerloom/orm";
import { InjectRepository } from "../stingerloom-orm/inject-repository.decorator";

@Injectable()
export class PostsService {
  constructor(
    @InjectRepository(Post)
    private readonly postRepository: BaseRepository<Post>,
  ) {}

  async create(dto: CreatePostDto): Promise<Post> {
    const post = new Post();
    post.title = dto.title;
    post.content = dto.content;
    if (dto.published !== undefined) post.published = dto.published;

    const result = await this.postRepository.save(post);
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Post[]> {
    const result = await this.postRepository.find({});
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<Post> {
    const result = await this.postRepository.findOne({ where: { id } as any });
    if (!result) throw new NotFoundException(`Post with ID ${id} not found`);
    return result;
  }

  async update(id: number, dto: UpdatePostDto): Promise<Post> {
    const post = await this.findOne(id);

    if (dto.title !== undefined) post.title = dto.title;
    if (dto.content !== undefined) post.content = dto.content;
    if (dto.published !== undefined) post.published = dto.published;

    const saved = await this.postRepository.save(post);
    return Array.isArray(saved) ? saved[0] : saved;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.postRepository.delete({ id } as any);
  }
}
