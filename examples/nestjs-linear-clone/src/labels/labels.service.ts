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
  qAlias,
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
    const l = qAlias(Label, "l");
    const dup = await this.em
      .createQueryBuilder(l)
      .where(l.projectId.eq(dto.projectId))
      .andWhere(l.name.eq(dto.name))
      .getOne();
    if (dup) {
      throw new ConflictException(
        `Label "${dto.name}" already exists in project ${dto.projectId}`,
      );
    }
    const label = new Label();
    label.projectId = dto.projectId;
    label.name = dto.name;
    if (dto.color) label.color = dto.color;
    return this.repo.save(label);
  }

  findAll(projectId?: number): Promise<Label[]> {
    const l = qAlias(Label, "l");
    return this.em
      .createQueryBuilder(l)
      .when(projectId !== undefined, (qb) =>
        qb.where(l.projectId.eq(projectId!)),
      )
      .getMany();
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
