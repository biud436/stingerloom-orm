import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Workspace } from "./workspace.entity";
import { CreateWorkspaceDto, UpdateWorkspaceDto } from "./dto/workspace.dto";

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Workspace)
    private readonly repo: BaseRepository<Workspace>,
  ) {}

  @Transactional()
  async create(dto: CreateWorkspaceDto): Promise<Workspace> {
    const dup = await this.repo.findOne({ where: { slug: dto.slug } });
    if (dup) throw new ConflictException(`Workspace slug already taken: ${dto.slug}`);

    const w = new Workspace();
    w.name = dto.name;
    w.slug = dto.slug;
    return this.repo.save(w);
  }

  findAll(): Promise<Workspace[]> {
    return this.repo.find();
  }

  async findOne(id: number): Promise<Workspace> {
    const w = await this.repo.findOne({ where: { id } });
    if (!w) throw new NotFoundException(`Workspace ${id} not found`);
    return w;
  }

  async findBySlug(slug: string): Promise<Workspace> {
    const w = await this.repo.findOne({ where: { slug } });
    if (!w) throw new NotFoundException(`Workspace ${slug} not found`);
    return w;
  }

  @Transactional()
  async update(id: number, dto: UpdateWorkspaceDto): Promise<Workspace> {
    const w = await this.findOne(id);
    if (dto.name !== undefined) w.name = dto.name;
    return this.repo.save(w);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }
}
