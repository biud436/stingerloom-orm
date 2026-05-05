import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  qAlias,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Comment } from "./comment.entity";
import { CreateCommentDto, UpdateCommentDto } from "./dto/comment.dto";
import { ActivityService } from "../activity/activity.service";
import { ACTIVITY_ACTION } from "../../common/enums";

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment)
    private readonly repo: BaseRepository<Comment>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
    private readonly activity: ActivityService,
  ) {}

  @Transactional()
  async create(dto: CreateCommentDto): Promise<Comment> {
    const c = new Comment();

    c.issueId = dto.issueId;

    if (dto.authorId !== undefined) {
      c.authorId = dto.authorId;
    }

    c.body = dto.body;
    const saved = await this.repo.save(c);

    await this.activity.log({
      issueId: dto.issueId,
      actorUserId: dto.authorId ?? null,
      action: ACTIVITY_ACTION.COMMENTED,
      payload: { commentId: saved.id },
    });

    return saved;
  }

  findByIssue(issueId: number): Promise<Comment[]> {
    const c = qAlias(Comment, "c");
    return this.em
      .createQueryBuilder(c)
      .where(c.issueId.eq(issueId))
      .orderBy(c.createdAt.asc())
      .getMany();
  }

  async findOne(id: number): Promise<Comment> {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) {
      throw new NotFoundException(`Comment ${id} not found`);
    }

    return c;
  }

  @Transactional()
  async update(id: number, dto: UpdateCommentDto): Promise<Comment> {
    const c = await this.findOne(id);
    c.body = dto.body;
    return this.repo.save(c);
  }

  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.softDelete({ id });
  }
}
