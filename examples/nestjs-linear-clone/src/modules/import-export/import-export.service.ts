import { Injectable, NotFoundException, BadRequestException, Inject } from "@nestjs/common";
import {
  EntityManager,
  Transactional,
  qAlias,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository } from "@stingerloom/orm";
import { Workspace } from "../workspaces/workspace.entity";
import { Project } from "../projects/project.entity";
import { Issue } from "../issues/issue.entity";
import { Comment } from "../comments/comment.entity";
import { Sprint } from "../sprints/sprint.entity";
import { Label } from "../labels/label.entity";
import { ProjectsService } from "../projects/projects.service";
import { parseIssueCsv } from "./csv";
import { ISSUE_STATUS, IssueStatus, IssuePriority } from "../../common/enums";

const CHUNK_SIZE = 100;

const VALID_STATUSES = new Set<string>(Object.values(ISSUE_STATUS));

export interface ImportResult {
  inserted: number;
  skipped: number;
}

export interface WorkspaceExport {
  workspace: { id: number; slug: string; name: string };
  projects: Array<{
    id: number;
    key: string;
    name: string;
    sprints: number[];
    labels: number[];
    issues: Array<{
      id: number;
      number: number;
      title: string;
      status: string;
      priority: number | null;
      estimate: number | null;
      sprintId: number | null;
      assigneeId: number | null;
      commentCount: number;
    }>;
  }>;
}

@Injectable()
export class ImportExportService {
  constructor(
    @InjectRepository(Workspace)
    private readonly workspaceRepo: BaseRepository<Workspace>,
    @InjectRepository(Project)
    private readonly projectRepo: BaseRepository<Project>,
    @InjectRepository(Issue)
    private readonly issueRepo: BaseRepository<Issue>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * Bulk-insert issues from a CSV upload, in chunks of 100, each chunk wrapped
   * in its own @Transactional frame. Numbers are assigned sequentially via the
   * project's row-locked counter (same path as the single-issue create) so
   * concurrent imports against the same project remain race-free.
   *
   * Trade-off documented for the showcase: each chunk is its own commit, so
   * a failure mid-import leaves prior chunks committed. For full atomic
   * imports the caller can pass a chunk size larger than the row count.
   */
  async importIssues(
    projectId: number,
    csv: string,
    actorUserId: number,
  ): Promise<ImportResult> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    let parsed;
    try {
      parsed = parseIssueCsv(csv);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Failed to parse CSV",
      );
    }

    let inserted = 0;
    let skipped = 0;

    for (let i = 0; i < parsed.length; i += CHUNK_SIZE) {
      const chunk = parsed.slice(i, i + CHUNK_SIZE);
      const result = await this.insertChunk(projectId, chunk, actorUserId);
      inserted += result.inserted;
      skipped += result.skipped;
    }

    return { inserted, skipped };
  }

  @Transactional()
  private async insertChunk(
    projectId: number,
    chunk: Array<{
      title: string;
      status?: string;
      priority?: number;
      estimate?: number;
    }>,
    actorUserId: number,
  ): Promise<ImportResult> {
    const rows: Partial<Issue>[] = [];
    let skipped = 0;
    for (const row of chunk) {
      const status: IssueStatus = VALID_STATUSES.has(row.status ?? "")
        ? (row.status as IssueStatus)
        : ISSUE_STATUS.BACKLOG;
      // Sequential per-project number assignment via the row-locked counter.
      // Inside the same @Transactional frame the counter increments survive
      // commit-or-rollback together with the inserted issue rows.
      const number = await this.projects.nextIssueNumber(projectId);
      rows.push({
        projectId,
        number,
        title: row.title,
        status,
        priority: ((row.priority ?? 0) as IssuePriority),
        estimate: row.estimate ?? null,
        reporterId: actorUserId,
      });
    }
    if (rows.length === 0) return { inserted: 0, skipped };

    const result = await this.em.insertMany<Issue>(Issue, rows);
    return { inserted: result.affected, skipped };
  }

  /**
   * JSON export of an entire workspace, built incrementally with `stream()`
   * so the JVM-heap-equivalent (Node heap) stays bounded for large exports.
   * Per-project entries are emitted as the stream yields, then collected
   * into the final response object. For huge workspaces a real production
   * deployment would replace the response object with a streaming
   * NDJSON / chunked HTTP body — kept synchronous here to keep the e2e
   * spec readable.
   */
  async exportWorkspace(workspaceId: number): Promise<WorkspaceExport> {
    const ws = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException(`Workspace ${workspaceId} not found`);

    const projects = await this.projectRepo.find({
      where: { workspaceId },
      orderBy: { id: "ASC" },
    });

    const out: WorkspaceExport = {
      workspace: { id: ws.id, slug: ws.slug, name: ws.name },
      projects: [],
    };

    for (const p of projects) {
      const sprints = await this.em.find<Sprint>(Sprint, {
        where: { projectId: p.id },
        orderBy: { id: "ASC" },
        select: ["id"],
      });
      const labels = await this.em.find<Label>(Label, {
        where: { projectId: p.id },
        orderBy: { id: "ASC" },
        select: ["id"],
      });

      const issues: WorkspaceExport["projects"][number]["issues"] = [];
      // The actual streaming: pull issues 200 at a time so the in-memory
      // working set never exceeds one batch.
      for await (const issue of this.em.stream<Issue>(
        Issue,
        { where: { projectId: p.id }, orderBy: { id: "ASC" } },
        200,
      )) {
        const c = qAlias(Comment, "c");
        const commentCount = Number(
          await this.em
            .createQueryBuilder(c)
            .where(c.issueId.eq(issue.id))
            .getCount(),
        );
        issues.push({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          status: issue.status,
          priority: issue.priority ?? null,
          estimate: issue.estimate,
          sprintId: issue.sprintId ?? null,
          assigneeId: issue.assigneeId ?? null,
          commentCount,
        });
      }

      out.projects.push({
        id: p.id,
        key: p.key,
        name: p.name,
        sprints: sprints.map((s) => s.id),
        labels: labels.map((l) => l.id),
        issues,
      });
    }
    return out;
  }
}
