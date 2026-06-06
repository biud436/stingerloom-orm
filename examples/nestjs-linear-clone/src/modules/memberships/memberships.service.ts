import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
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
import { RequestContextStore } from "../../common/context/request-context";
import { MEMBERSHIP_ROLE, MembershipRole } from "../../common/enums";

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
    // @WorkspaceScoped proves the actor is *a* member of dto.workspaceId; it
    // does NOT prove they may grant roles. Without this gate any GUEST/MEMBER
    // could POST a membership with role OWNER (for themselves or a sock-puppet)
    // and take over the workspace. Require ADMIN/OWNER, mirroring updateRole.
    await this.assertActorIsAdmin(dto.workspaceId);

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

  async byWorkspace(workspaceId: number): Promise<Membership[]> {
    // Only members of the workspace may enumerate its roster (which joins User
    // and exposes names/emails). Without this check any authenticated user
    // could dump any workspace's members by guessing the id.
    await this.assertActorIsMember(workspaceId);

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

    // @WorkspaceScoped proves the actor is *a* member of this workspace; the
    // role gate stops a GUEST/MEMBER from escalating anyone (incl. themselves).
    await this.assertActorIsAdmin(m.workspaceId!);

    // Don't strand a workspace with zero OWNERs by demoting the last one.
    if (m.role === MEMBERSHIP_ROLE.OWNER && dto.role !== MEMBERSHIP_ROLE.OWNER) {
      await this.assertNotLastOwner(m.workspaceId!, m.id!);
    }

    m.role = dto.role;

    return this.repo.save(m);
  }

  @Transactional()
  async revoke(id: number): Promise<void> {
    const m = await this.repo.findOne({ where: { id } });

    if (!m) {
      throw new NotFoundException(`Membership ${id} not found`);
    }

    await this.assertActorIsAdmin(m.workspaceId!);

    if (m.role === MEMBERSHIP_ROLE.OWNER) {
      await this.assertNotLastOwner(m.workspaceId!, m.id!);
    }

    await this.repo.delete({ id });
  }

  // ── role / ownership guards ─────────────────────────────────

  /**
   * Require the authenticated actor to hold ADMIN or OWNER in the target
   * workspace. The @WorkspaceScoped guard already verified the actor is *a*
   * member there and stamped `RequestContext.userId`; this adds the role gate
   * that membership alone does not provide.
   */
  /**
   * Require the authenticated actor to be a member (any role) of the workspace.
   * Used to gate roster reads — membership alone is enough to see the member
   * list, but a non-member must not.
   */
  private async assertActorIsMember(workspaceId: number): Promise<void> {
    const actorUserId = RequestContextStore.get()?.userId;
    if (!actorUserId) {
      throw new ForbiddenException("Authentication required");
    }
    const m = qAlias(Membership, "m");
    const row = await this.em
      .createQueryBuilder(m)
      .where(m.workspaceId.eq(workspaceId))
      .andWhere(m.userId.eq(actorUserId))
      .limit(1)
      .getOne();
    if (!row) {
      throw new ForbiddenException(
        `User is not a member of workspace ${workspaceId}`,
      );
    }
  }

  private async assertActorIsAdmin(workspaceId: number): Promise<void> {
    const actorUserId = RequestContextStore.get()?.userId;
    if (!actorUserId) {
      throw new ForbiddenException("Authentication required");
    }
    const m = qAlias(Membership, "m");
    const row = await this.em
      .createQueryBuilder(m)
      .where(m.workspaceId.eq(workspaceId))
      .andWhere(m.userId.eq(actorUserId))
      .limit(1)
      .getOne();
    const role = row?.role as MembershipRole | undefined;
    if (role !== MEMBERSHIP_ROLE.OWNER && role !== MEMBERSHIP_ROLE.ADMIN) {
      throw new ForbiddenException(
        "Only an ADMIN or OWNER may change roles or revoke members",
      );
    }
  }

  /**
   * Block an operation that would leave `workspaceId` with no OWNER. Counts the
   * OWNER memberships other than the one being demoted/revoked.
   */
  private async assertNotLastOwner(
    workspaceId: number,
    excludingMembershipId: number,
  ): Promise<void> {
    const m = qAlias(Membership, "m");
    const owners = await this.em
      .createQueryBuilder(m)
      .where(m.workspaceId.eq(workspaceId))
      .andWhere(m.role.eq(MEMBERSHIP_ROLE.OWNER))
      .getMany();
    const remaining = owners.filter((o) => o.id !== excludingMembershipId);
    if (remaining.length === 0) {
      throw new ConflictException(
        "Cannot remove or demote the last OWNER of the workspace",
      );
    }
  }
}
