import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
} from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  sql,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Project } from "./project.entity";
import { CreateProjectDto, UpdateProjectDto } from "./dto/project.dto";

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly repo: BaseRepository<Project>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async create(dto: CreateProjectDto): Promise<Project> {
    const dup = await this.em
      .createQueryBuilder(Project, "p")
      .where("p.workspace_id", dto.workspaceId)
      .andWhere("p.key", dto.key)
      .getOne();
    if (dup) {
      throw new ConflictException(
        `Project key ${dto.key} already exists in workspace ${dto.workspaceId}`,
      );
    }

    const p = new Project();
    p.workspaceId = dto.workspaceId;
    p.name = dto.name;
    p.key = dto.key;
    if (dto.description) p.description = dto.description;
    if (dto.customFieldSchema) {
      p.customFieldSchema = JSON.stringify(dto.customFieldSchema) as any;
    }
    return this.repo.save(p);
  }

  findAll(workspaceId?: number): Promise<Project[]> {
    const qb = this.em.createQueryBuilder(Project, "p");
    if (workspaceId !== undefined) qb.where("p.workspace_id", workspaceId);
    return qb.getMany();
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
      p.customFieldSchema = JSON.stringify(dto.customFieldSchema) as any;
    }
    return this.repo.save(p);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }

  /**
   * Atomic per-project counter increment used to assign issue numbers.
   *
   * MySQL/MariaDB do not return the post-increment value in a single
   * statement (PostgreSQL has `RETURNING`), so we do `UPDATE … SET col = col + 1`
   * and then read the column back. The whole pair lives inside the calling
   * transaction (callers wrap in @Transactional), guaranteeing atomicity.
   */
  async nextIssueNumber(projectId: number): Promise<number> {
    const isPg = this.em
      .getDriver()
      .constructor.name.toLowerCase()
      .includes("postgres");

    if (isPg) {
      const rows = await this.em.query<{ next: number }>(
        sql`UPDATE "project"
              SET "issueCounter" = "issueCounter" + 1
            WHERE "id" = ${projectId}
        RETURNING "issueCounter" AS next`,
      );
      return Number(rows[0]?.next ?? 0);
    }

    await this.em.query(
      sql`UPDATE \`project\`
             SET \`issueCounter\` = \`issueCounter\` + 1
           WHERE \`id\` = ${projectId}`,
    );
    const rows = await this.em.query<{ next: number }>(
      sql`SELECT \`issueCounter\` AS next FROM \`project\` WHERE \`id\` = ${projectId}`,
    );
    return Number(rows[0]?.next ?? 0);
  }
}
