import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateTagDto } from "./dto/create-tag.dto";
import { Tag } from "./tag.entity";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "src/stingerloom-orm/inject-repository.decorator";

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(Tag)
    private readonly tagRepository: BaseRepository<Tag>,
  ) {}

  @Transactional()
  async create(dto: CreateTagDto): Promise<Tag> {
    const tag = new Tag();
    tag.name = dto.name;

    const result = await this.tagRepository.save(tag);
    return Array.isArray(result) ? result[0] : result;
  }

  async findAll(): Promise<Tag[]> {
    const result = await this.tagRepository.find();
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async findOne(id: number): Promise<Tag> {
    const result = await this.tagRepository.findOne({
      where: { id },
    });

    if (!result) throw new NotFoundException(`Tag with ID ${id} not found`);
    return Array.isArray(result) ? result[0] : result;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.tagRepository.delete({ id });
  }

  async count(): Promise<number> {
    return this.tagRepository.count();
  }

  /**
   * upsert — name 기준으로 태그를 생성하거나 업데이트합니다.
   */
  async upsertByName(name: string): Promise<{ message: string }> {
    const tag = new Tag();
    tag.name = name;
    await this.tagRepository.upsert(tag, ["name"]);
    return { message: `Tag upserted: ${name}` };
  }

  /**
   * findAndCount — 태그 목록 + 총 개수 반환.
   */
  async findPaginated(
    page = 1,
    limit = 10,
  ): Promise<{ data: Tag[]; total: number }> {
    const [data, total] = await this.tagRepository.findAndCount({
      limit: [(page - 1) * limit, limit],
    });
    return { data, total };
  }
}
