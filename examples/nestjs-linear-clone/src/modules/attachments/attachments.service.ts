import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  qAlias,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import {
  Attachment,
  ATTACHMENT_OWNER,
  AttachmentOwnerType,
} from "./attachment.entity";
import { Issue } from "../issues/issue.entity";
import { Comment } from "../comments/comment.entity";
import { CreateAttachmentDto } from "./dto/attachment.dto";

@Injectable()
export class AttachmentsService {
  constructor(
    @InjectRepository(Attachment)
    private readonly repo: BaseRepository<Attachment>,
    @InjectRepository(Issue)
    private readonly issueRepo: BaseRepository<Issue>,
    @InjectRepository(Comment)
    private readonly commentRepo: BaseRepository<Comment>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  /**
   * Service-layer integrity check. Because the discriminator-column model
   * has no FK on (owner_type, owner_id), the parent must be verified before
   * insert; otherwise an attachment can dangle pointing at a deleted issue.
   */
  private async assertOwnerExists(
    ownerType: AttachmentOwnerType,
    ownerId: number,
  ): Promise<void> {
    if (ownerType === ATTACHMENT_OWNER.ISSUE) {
      const issue = await this.issueRepo.findOne({ where: { id: ownerId } });
      if (!issue) throw new NotFoundException(`Issue ${ownerId} not found`);
      return;
    }
    if (ownerType === ATTACHMENT_OWNER.COMMENT) {
      const c = await this.commentRepo.findOne({ where: { id: ownerId } });
      if (!c) throw new NotFoundException(`Comment ${ownerId} not found`);
      return;
    }
    throw new NotFoundException(`Unknown owner type: ${ownerType}`);
  }

  @Transactional()
  async create(
    ownerType: AttachmentOwnerType,
    ownerId: number,
    actorUserId: number,
    dto: CreateAttachmentDto,
  ): Promise<Attachment> {
    await this.assertOwnerExists(ownerType, ownerId);

    const a = new Attachment();
    a.ownerType = ownerType;
    a.ownerId = ownerId;
    a.filename = dto.filename;
    a.contentType = dto.contentType;
    a.sizeBytes = dto.sizeBytes;
    a.storageUrl = dto.storageUrl;
    a.uploadedById = actorUserId;
    return this.repo.save(a);
  }

  /**
   * Per-owner attachment list, sorted newest-first. Hits the
   * (owner_type, owner_id) composite index.
   */
  async listByOwner(
    ownerType: AttachmentOwnerType,
    ownerId: number,
  ): Promise<Attachment[]> {
    const a = qAlias(Attachment, "a");
    return this.em
      .createQueryBuilder(a)
      .where(a.ownerType.eq(ownerType))
      .andWhere(a.ownerId.eq(ownerId))
      .orderBy(a.id.desc())
      .getMany();
  }

  async findOne(id: number): Promise<Attachment> {
    const a = await this.repo.findOne({ where: { id } });
    if (!a) throw new NotFoundException(`Attachment ${id} not found`);
    return a;
  }

  @Transactional()
  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }
}
