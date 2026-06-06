import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BaseRepository,
  CursorPaginationResult,
  EntityManager,
  Transactional,
  encodeCursor,
  qAlias,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Issue } from "../issues/issue.entity";
import { Project } from "../projects/project.entity";
import { Membership } from "../memberships/membership.entity";
import { RequestContextStore } from "../../common/context/request-context";
import { CreateSavedFilterDto } from "./dto/saved-filter.dto";
import { SavedFilter } from "./saved-filter.entity";
import { compileFilter } from "./compile-filter";

@Injectable()
export class SavedFiltersService {
  constructor(
    @InjectRepository(SavedFilter)
    private readonly repo: BaseRepository<SavedFilter>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async create(
    dto: CreateSavedFilterDto,
    ownerId: number,
  ): Promise<SavedFilter> {
    // Compile (and therefore validate) the AST before persisting so we never
    // store a filter that cannot be executed.
    compileFilter(dto.definition, { userId: ownerId });

    const filter = new SavedFilter();
    filter.workspaceId = dto.workspaceId;
    filter.ownerId = ownerId;
    filter.name = dto.name;
    filter.definition = dto.definition;
    return this.repo.save(filter);
  }

  /**
   * List saved filters scoped to the workspaces the caller is a member of.
   * Without this scope `GET /saved-filters` enumerated every tenant's filters
   * (names, owner ids, and the full predicate AST). Returns `[]` when the user
   * belongs to no workspace.
   */
  async findAll(userId: number): Promise<SavedFilter[]> {
    const m = qAlias(Membership, "m");
    const memberships = await this.em
      .createQueryBuilder(m)
      .where(m.userId.eq(userId))
      .getMany();
    const workspaceIds = memberships
      .map((row) => row.workspaceId)
      .filter((id): id is number => id != null);
    if (workspaceIds.length === 0) return [];

    const f = qAlias(SavedFilter, "f");
    return this.em
      .createQueryBuilder(f)
      .where(f.workspaceId.in(workspaceIds))
      .orderBy(f.id.desc())
      .getMany();
  }

  async findOne(id: number): Promise<SavedFilter> {
    const filter = await this.repo.findOne({ where: { id } });
    if (!filter) throw new NotFoundException(`SavedFilter ${id} not found`);
    return filter;
  }

  async remove(id: number): Promise<void> {
    const result = await this.repo.delete({ id });
    if (result.affected === 0) {
      throw new NotFoundException(`SavedFilter ${id} not found`);
    }
  }

  /**
   * Run a saved filter, returning a cursor-paginated page of issues.
   *
   * `findWithCursor` only accepts a `WhereClause<T>`, so we build the qb
   * ourselves: apply the compiled scope, order by `id ASC`, take `take + 1`
   * to detect a next page, and emit a CursorPaginationResult-shaped response
   * encoded with the ORM's own cursor codec.
   */
  async run(
    filterId: number,
    take: number,
    cursor?: string,
  ): Promise<CursorPaginationResult<Issue>> {
    const filter = await this.findOne(filterId);
    const ctx = RequestContextStore.require();
    const scope = compileFilter(filter.definition, { userId: ctx.userId });

    // Tenant boundary: the compiled predicate (built from the user's AST over
    // the Issue allowlist) carries NO workspace constraint, so it would match
    // issues across every tenant. Pin the run to the projects owned by the
    // filter's workspace — even if the filter body sets a foreign `projectId`,
    // the AND with this set keeps results inside the filter's tenant.
    const projectIds = await this.workspaceProjectIds(filter.workspaceId!);
    const i = qAlias(Issue, "i");
    if (projectIds.length === 0) {
      return { data: [], hasNextPage: false, nextCursor: null, count: 0 };
    }
    let qb = this.em
      .createQueryBuilder(i)
      .pipe(scope)
      .andWhere(i.projectId.in(projectIds))
      .orderBy(i.id.asc())
      .take(take + 1);

    if (cursor !== undefined) {
      const decoded = decodeCursorId(cursor);
      if (decoded !== null) qb = qb.andWhere(i.id.gt(decoded));
    }

    const rows = await qb.getMany();
    const hasNextPage = rows.length > take;
    const data = hasNextPage ? rows.slice(0, take) : rows;
    const last = data[data.length - 1];
    return {
      data,
      hasNextPage,
      nextCursor:
        hasNextPage && last !== undefined ? encodeCursor(last.id) : null,
      count: data.length,
    };
  }

  /** Project ids that belong to a workspace — the tenant fence for `run`. */
  private async workspaceProjectIds(workspaceId: number): Promise<number[]> {
    const p = qAlias(Project, "p");
    const projects = await this.em
      .createQueryBuilder(p)
      .where(p.workspaceId.eq(workspaceId))
      .getMany();
    return projects
      .map((row) => row.id)
      .filter((id): id is number => id != null);
  }
}

function decodeCursorId(cursor: string): number | null {
  try {
    const json = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as { v?: unknown };
    if (typeof parsed.v === "number" && Number.isFinite(parsed.v)) {
      return parsed.v;
    }
    return null;
  } catch {
    return null;
  }
}
