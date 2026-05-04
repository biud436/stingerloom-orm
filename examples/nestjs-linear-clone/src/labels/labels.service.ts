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
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Label } from "./label.entity";
import { CreateLabelDto } from "./dto/label.dto";

@Injectable()
export class LabelsService {
  constructor(
    @InjectRepository(Label)
    private readonly repo: BaseRepository<Label>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async create(dto: CreateLabelDto): Promise<Label> {
    const dup = await this.em
      .createQueryBuilder(Label, "l")
      .where("l.project_id", dto.projectId)
      .andWhere("l.name", dto.name)
      .getOne();
    if (dup) {
      throw new ConflictException(
        `Label "${dto.name}" already exists in project ${dto.projectId}`,
      );
    }
    const l = new Label();
    l.projectId = dto.projectId;
    l.name = dto.name;
    if (dto.color) l.color = dto.color;
    return this.repo.save(l);
  }

  findAll(projectId?: number): Promise<Label[]> {
    const qb = this.em.createQueryBuilder(Label, "l");
    if (projectId !== undefined) qb.where("l.project_id", projectId);
    return qb.getMany();
  }

  async findOne(id: number): Promise<Label> {
    const l = await this.repo.findOne({ where: { id } });
    if (!l) throw new NotFoundException(`Label ${id} not found`);
    return l;
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }
}
