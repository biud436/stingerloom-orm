import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
} from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  qAlias,
  Transactional,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Membership } from "./membership.entity";
import {
  CreateMembershipDto,
  UpdateMembershipRoleDto,
} from "./dto/membership.dto";
import { User } from "../users/user.entity";

@Injectable()
export class MembershipsService {
  constructor(
    @InjectRepository(Membership)
    private readonly repo: BaseRepository<Membership>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async invite(dto: CreateMembershipDto): Promise<Membership> {
    const memberShip = qAlias(Membership, "m");

    const existing = await this.em
      .createQueryBuilder(memberShip)
      .where(memberShip.workspaceId.eq(dto.workspaceId))
      .andWhere(memberShip.userId.eq(dto.userId))
      .getOne();

    if (existing) {
      throw new ConflictException(
        `User ${dto.userId} is already a member of workspace ${dto.workspaceId}`,
      );
    }

    const m = new Membership();
    m.workspaceId = dto.workspaceId;
    m.userId = dto.userId;
    m.role = dto.role;

    return this.repo.save(m);
  }

  byWorkspace(workspaceId: number): Promise<Membership[]> {
    const memberShip = qAlias(Membership, "m");

    return this.em
      .createQueryBuilder(memberShip)
      .leftJoinRelationAndSelect("user", "u")
      .where(memberShip.workspaceId.eq(workspaceId))
      .getMany();
  }

  byUser(userId: number): Promise<Membership[]> {
    const memberShip = qAlias(Membership, "m");

    return this.em
      .createQueryBuilder(memberShip)
      .leftJoinRelationAndSelect("workspace", "w") // qAlias를 못쓰는 것 같다.
      .where(memberShip.userId.eq(userId))
      .getMany();
  }

  @Transactional()
  async updateRole(
    id: number,
    dto: UpdateMembershipRoleDto,
  ): Promise<Membership> {
    const m = await this.repo.findOne({ where: { id } });
    if (!m) {
      throw new NotFoundException(`Membership ${id} not found`);
    }

    m.role = dto.role;

    return this.repo.save(m);
  }

  async revoke(id: number): Promise<void> {
    const m = await this.repo.findOne({ where: { id } });

    if (!m) {
      throw new NotFoundException(`Membership ${id} not found`);
    }

    await this.repo.delete({ id });
  }
}
