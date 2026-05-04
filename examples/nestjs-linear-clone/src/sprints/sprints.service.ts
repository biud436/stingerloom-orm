import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Sprint } from "./sprint.entity";
import { CreateSprintDto, UpdateSprintDto } from "./dto/sprint.dto";
import { applyPatch, pickDefined } from "../common/dto-helpers";

const SPRINT_PATCH_KEYS = ["name", "status"] as const;

@Injectable()
export class SprintsService {
  constructor(
    @InjectRepository(Sprint)
    private readonly repo: BaseRepository<Sprint>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async create(dto: CreateSprintDto): Promise<Sprint> {
    const s = new Sprint();
    s.projectId = dto.projectId;
    s.name = dto.name;
    s.status = dto.status;
    s.startDate = dto.startDate ? new Date(dto.startDate) : null;
    s.endDate = dto.endDate ? new Date(dto.endDate) : null;
    return this.repo.save(s);
  }

  findAll(projectId?: number): Promise<Sprint[]> {
    const qb = this.em.createQueryBuilder(Sprint, "s");
    if (projectId !== undefined) qb.where("s.project_id", projectId);
    return qb.getMany();
  }

  async findOne(id: number): Promise<Sprint> {
    const s = await this.repo.findOne({ where: { id } });
    if (!s) throw new NotFoundException(`Sprint ${id} not found`);
    return s;
  }

  @Transactional()
  async update(id: number, dto: UpdateSprintDto): Promise<Sprint> {
    const s = await this.findOne(id);
    applyPatch(s, pickDefined(dto, SPRINT_PATCH_KEYS) as unknown as Partial<Sprint>);
    if (dto.startDate !== undefined) s.startDate = new Date(dto.startDate);
    if (dto.endDate !== undefined) s.endDate = new Date(dto.endDate);
    return this.repo.save(s);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }
}
