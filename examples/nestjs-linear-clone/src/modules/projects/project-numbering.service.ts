import { Injectable } from "@nestjs/common";
import { BaseRepository, qAlias } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Project } from "./project.entity";

/**
 * Owns the atomic per-project issue-number counter.
 *
 * Carved out of `ProjectsService` so `IssuesModule` and `ImportExportModule`
 * can depend on just the counter — they need a fresh issue number, not the
 * full project CRUD surface. Because this service depends only on the
 * `Project` repository (never on `IssuesService`), the Issues ↔ Projects
 * module cycle disappears and neither side needs `forwardRef`.
 */
@Injectable()
export class ProjectNumberingService {
  constructor(
    @InjectRepository(Project)
    private readonly repo: BaseRepository<Project>,
  ) {}

  /**
   * Atomic per-project counter increment used to assign issue numbers.
   * `forUpdate()` locks the row, then `save()` writes the bumped counter —
   * concurrent `nextIssueNumber()` calls serialize on the row lock, so
   * each one sees a fresh value. Callers wrap this in `@Transactional`,
   * which is required for the lock to span the read/write pair.
   */
  async nextIssueNumber(projectId: number): Promise<number> {
    const p = qAlias(Project, "p");
    const project = await this.repo
      .createQueryBuilder(p)
      .where(p.id.eq(projectId))
      .forUpdate()
      .getOneOrFail();

    project.issueCounter = (project.issueCounter ?? 0) + 1;
    await this.repo.save(project);
    return project.issueCounter;
  }
}
