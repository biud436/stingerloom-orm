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

  findAll(): Promise<SavedFilter[]> {
    const f = qAlias(SavedFilter, "f");
    return this.em
      .createQueryBuilder(f)
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

    const i = qAlias(Issue, "i");
    let qb = this.em
      .createQueryBuilder(i)
      .pipe(scope)
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
