import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Workspace } from "./workspace.entity";
import { CreateWorkspaceDto, UpdateWorkspaceDto } from "./dto/workspace.dto";
import { Membership } from "../memberships/membership.entity";
import { MEMBERSHIP_ROLE } from "../../common/enums";

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Workspace)
    private readonly repo: BaseRepository<Workspace>,
    @InjectRepository(Membership)
    private readonly memberships: BaseRepository<Membership>,
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

  /**
   * Create a workspace and atomically enroll the caller as OWNER. Without
   * this both-or-nothing step, the very next request from the creator would
   * be rejected by `WorkspaceMemberGuard` because no membership row exists.
   */
  @Transactional()
  async createWithOwner(dto: CreateWorkspaceDto, userId: number): Promise<Workspace> {
    const w = await this.create(dto);
    const m = new Membership();
    m.workspaceId = w.id;
    m.userId = userId;
    m.role = MEMBERSHIP_ROLE.OWNER;
    await this.memberships.save(m);
    return w;
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
