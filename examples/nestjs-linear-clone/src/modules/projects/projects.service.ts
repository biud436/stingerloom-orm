import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { BaseRepository, Transactional, qAlias } from "@stingerloom/orm";
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

  findAll(workspaceId?: number): Promise<Project[]> {
    const p = qAlias(Project, "p");
    return this.repo
      .createQueryBuilder(p)
      .when(workspaceId !== undefined, (qb) =>
        qb.where(p.workspaceId.eq(workspaceId!)),
      )
      .getMany();
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

  /**
   * Atomic per-project counter increment used to assign issue numbers.
   * `forUpdate()` locks the row, then `save()` writes the bumped counter —
   * concurrent `nextIssueNumber()` calls serialize on the row lock, so
   * each one sees a fresh value. Callers wrap this in `@Transactional`,
   * which is required for the lock to span the read/write pair.
   */
  async nextIssueNumber(projectId: number): Promise<number> {
    const p = qAlias(Project, "p");
    const project = await this.repo
      .createQueryBuilder(p)
      .where(p.id.eq(projectId))
      .forUpdate()
      .getOneOrFail();

    project.issueCounter = (project.issueCounter ?? 0) + 1;
    await this.repo.save(project);
    return project.issueCounter;
  }
}
