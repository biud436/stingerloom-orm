import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import {
  BaseRepository,
  Transactional,
  qAlias,
  CursorPaginationResult,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Project } from "./project.entity";
import { CreateProjectDto, UpdateProjectDto } from "./dto/project.dto";

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly repo: BaseRepository<Project>,
  ) {}

  @Transactional()
  async create(dto: CreateProjectDto): Promise<Project> {
    const p = qAlias(Project, "p");
    const dup = await this.repo
      .createQueryBuilder(p)
      .where(p.workspaceId.eq(dto.workspaceId))
      .andWhere(p.key.eq(dto.key))
      .getOne();

    if (dup) {
      throw new ConflictException(
        `Project key ${dto.key} already exists in workspace ${dto.workspaceId}`,
      );
    }

    const project = new Project();
    project.workspaceId = dto.workspaceId;
    project.name = dto.name;
    project.key = dto.key;
    if (dto.description) project.description = dto.description;
    if (dto.customFieldSchema !== undefined) {
      project.customFieldSchema = dto.customFieldSchema;
    }
    return this.repo.save(project);
  }

  findAll(workspaceId?: number, limit = 50): Promise<Project[]> {
    const p = qAlias(Project, "p");
    return this.repo
      .createQueryBuilder(p)
      .when(workspaceId !== undefined, (qb) =>
        qb.where(p.workspaceId.eq(workspaceId!)),
      )
      .orderBy(p.id.asc())
      .take(Math.min(limit, 100))
      .getMany();
  }

  findWithCursor(
    workspaceId: number | undefined,
    take = 20,
    cursor?: string,
  ): Promise<CursorPaginationResult<Project>> {
    return this.repo.findWithCursor({
      take,
      cursor,
      orderBy: "id",
      direction: "ASC",
      where: workspaceId !== undefined ? { workspaceId } : undefined,
    });
  }

  async findOne(id: number): Promise<Project> {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException(`Project ${id} not found`);
    return p;
  }

  @Transactional()
  async update(id: number, dto: UpdateProjectDto): Promise<Project> {
    const p = await this.findOne(id);
    if (dto.name !== undefined) p.name = dto.name;
    if (dto.description !== undefined) p.description = dto.description;
    if (dto.customFieldSchema !== undefined) {
      p.customFieldSchema = dto.customFieldSchema;
    }
    return this.repo.save(p);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }
}
