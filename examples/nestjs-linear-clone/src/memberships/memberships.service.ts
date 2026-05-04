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
    const m = qAlias(Membership, "m");

    const existing = await this.em
      .createQueryBuilder(m)
      .where(m.workspaceId.eq(dto.workspaceId))
      .andWhere(m.userId.eq(dto.userId))
      .getOne();

    if (existing) {
      throw new ConflictException(
        `User ${dto.userId} is already a member of workspace ${dto.workspaceId}`,
      );
    }

    const membership = new Membership();
    membership.workspaceId = dto.workspaceId;
    membership.userId = dto.userId;
    membership.role = dto.role;

    return this.repo.save(membership);
  }

  byWorkspace(workspaceId: number): Promise<Membership[]> {
    const m = qAlias(Membership, "m");

    return this.em
      .createQueryBuilder(m)
      .leftJoinRelationAndSelect("user", "u")
      .where(m.workspaceId.eq(workspaceId))
      .getMany();
  }

  byUser(userId: number): Promise<Membership[]> {
    const m = qAlias(Membership, "m");

    // `leftJoinRelationAndSelect` reads the `@ManyToOne workspace` relation
    // metadata to derive the JOIN ON clause and alias automatically — no
    // qAlias is needed for the joined side. Use the typed `leftJoin(Entity,
    // alias, fn)` form when you want a `qAlias()` reference for the joined
    // entity's columns in WHERE / SELECT.
    return this.em
      .createQueryBuilder(m)
      .leftJoinRelationAndSelect("workspace", "w")
      .where(m.userId.eq(userId))
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
