import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  Inject,
} from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  qAlias,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { WorkflowDefinition } from "./workflow-definition.entity";
import { WorkflowTransition } from "./workflow-transition.entity";
import { CreateTransitionDto } from "./dto/workflow.dto";
import { Project } from "../projects/project.entity";
import {
  ISSUE_STATUS,
  IssueStatus,
  MEMBERSHIP_ROLE,
  MembershipRole,
} from "../../common/enums";

const DEFAULT_STATES: IssueStatus[] = [
  ISSUE_STATUS.BACKLOG,
  ISSUE_STATUS.TODO,
  ISSUE_STATUS.IN_PROGRESS,
  ISSUE_STATUS.IN_REVIEW,
  ISSUE_STATUS.DONE,
  ISSUE_STATUS.CANCELED,
];

// Permissive default chain: forward path BACKLOG→TODO→IN_PROGRESS→IN_REVIEW→DONE, reverse where it matters, CANCELED from anywhere. Wide enough to keep existing issues e2e tests passing without per-test setup.
function defaultTransitionPairs(): Array<[IssueStatus, IssueStatus]> {
  const forward: Array<[IssueStatus, IssueStatus]> = [
    [ISSUE_STATUS.BACKLOG, ISSUE_STATUS.TODO],
    [ISSUE_STATUS.TODO, ISSUE_STATUS.IN_PROGRESS],
    [ISSUE_STATUS.IN_PROGRESS, ISSUE_STATUS.IN_REVIEW],
    [ISSUE_STATUS.IN_REVIEW, ISSUE_STATUS.DONE],
    [ISSUE_STATUS.IN_PROGRESS, ISSUE_STATUS.DONE],
    [ISSUE_STATUS.TODO, ISSUE_STATUS.BACKLOG],
    [ISSUE_STATUS.IN_PROGRESS, ISSUE_STATUS.TODO],
    [ISSUE_STATUS.IN_PROGRESS, ISSUE_STATUS.BACKLOG],
    [ISSUE_STATUS.IN_REVIEW, ISSUE_STATUS.IN_PROGRESS],
    [ISSUE_STATUS.DONE, ISSUE_STATUS.IN_REVIEW],
  ];
  const cancels: Array<[IssueStatus, IssueStatus]> = DEFAULT_STATES.filter(
    (s) => s !== ISSUE_STATUS.CANCELED,
  ).map((s) => [s, ISSUE_STATUS.CANCELED]);
  return [...forward, ...cancels];
}

const ROLE_RANK: Record<MembershipRole, number> = {
  [MEMBERSHIP_ROLE.GUEST]: 0,
  [MEMBERSHIP_ROLE.MEMBER]: 1,
  [MEMBERSHIP_ROLE.ADMIN]: 2,
  [MEMBERSHIP_ROLE.OWNER]: 3,
};

function roleSatisfies(actual: MembershipRole | null | undefined, required: MembershipRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// URL-safe encoding of the composite (fromState, toState) PK. State names are enum-constrained, so `__` is a safe separator.
export function encodeTransitionId(fromState: string, toState: string): string {
  return `${fromState}__${toState}`;
}

function decodeTransitionId(transitionId: string): { fromState: string; toState: string } {
  const idx = transitionId.indexOf("__");
  if (idx <= 0 || idx === transitionId.length - 2) {
    throw new NotFoundException(`Transition ${transitionId} not found`);
  }
  return {
    fromState: transitionId.slice(0, idx),
    toState: transitionId.slice(idx + 2),
  };
}

export interface WorkflowViolationDetails {
  code: "WORKFLOW_VIOLATION";
  rule:
    | "TRANSITION_NOT_ALLOWED"
    | "INSUFFICIENT_ROLE"
    | "REQUIRED_FIELDS_MISSING";
  fromState: string;
  toState: string;
  requiredRole?: MembershipRole;
  missing?: string[];
}

export class WorkflowViolationException extends UnprocessableEntityException {
  constructor(details: WorkflowViolationDetails) {
    super(details);
  }
}

@Injectable()
export class WorkflowsService {
  constructor(
    @InjectRepository(WorkflowDefinition)
    private readonly defs: BaseRepository<WorkflowDefinition>,
    @InjectRepository(WorkflowTransition)
    private readonly transitions: BaseRepository<WorkflowTransition>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  // Get or atomically seed the default chain. Concurrent first-time readers race on the unique(project_id) index; loser re-reads.
  @Transactional()
  async getOrSeed(projectId: number): Promise<{
    definition: WorkflowDefinition;
    transitions: WorkflowTransition[];
  }> {
    // Confirm the project exists (404 otherwise) without depending on
    // ProjectsService — a direct EntityManager read keeps WorkflowsModule
    // off the Issues ↔ Projects cycle, so it needs no forwardRef.
    const project = await this.em.findOne(Project, {
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    let def = await this.defs.findOne({ where: { projectId } });
    if (!def) {
      try {
        def = await this.seedDefault(projectId);
      } catch (err) {
        // Lose the race: another writer just inserted; re-read.
        const reread = await this.defs.findOne({ where: { projectId } });
        if (!reread) throw err;
        def = reread;
      }
    }
    const transitions = await this.transitions.find({
      where: { definitionId: def.id },
      orderBy: { fromState: "ASC" },
    });
    return { definition: def, transitions };
  }

  private async seedDefault(projectId: number): Promise<WorkflowDefinition> {
    const def = new WorkflowDefinition();
    def.projectId = projectId;
    def.states = [...DEFAULT_STATES];
    const saved = await this.defs.save(def);

    const rows = defaultTransitionPairs().map(([from, to]) => {
      const t = new WorkflowTransition();
      t.definitionId = saved.id;
      t.fromState = from;
      t.toState = to;
      t.requiredRole = null;
      t.requiredFields = null;
      return t;
    });
    for (const row of rows) {
      await this.transitions.save(row);
    }
    return saved;
  }

  @Transactional()
  async addTransition(
    projectId: number,
    dto: CreateTransitionDto,
  ): Promise<WorkflowTransition> {
    const { definition } = await this.getOrSeed(projectId);
    const existing = await this.transitions.findOne({
      where: {
        definitionId: definition.id,
        fromState: dto.fromState,
        toState: dto.toState,
      },
    });
    if (existing) {
      throw new ConflictException(
        `Transition ${dto.fromState} → ${dto.toState} already defined for project ${projectId}`,
      );
    }
    const row = new WorkflowTransition();
    row.definitionId = definition.id;
    row.fromState = dto.fromState;
    row.toState = dto.toState;
    row.requiredRole = dto.requiredRole ?? null;
    row.requiredFields = dto.requiredFields ?? null;
    return this.transitions.save(row);
  }

  @Transactional()
  async removeTransition(projectId: number, transitionId: string): Promise<void> {
    const { fromState, toState } = decodeTransitionId(transitionId);
    const { definition } = await this.getOrSeed(projectId);
    const existing = await this.transitions.findOne({
      where: { definitionId: definition.id, fromState, toState },
    });
    if (!existing) {
      throw new NotFoundException(
        `Transition ${fromState} → ${toState} not found for project ${projectId}`,
      );
    }
    await this.transitions.delete({
      definitionId: definition.id,
      fromState,
      toState,
    });
  }

  // Validate a transition; throws 422 WorkflowViolationException with structured `{ code, rule, ... }` payload. Locks the definition row so concurrent rule edits serialize.
  async assertTransition(
    projectId: number,
    fromState: IssueStatus,
    toState: IssueStatus,
    userRole: MembershipRole | null | undefined,
    patchedIssue: Record<string, unknown>,
  ): Promise<void> {
    if (fromState === toState) return;

    // Lock the definition row first so concurrent rule edits serialize.
    const d = qAlias(WorkflowDefinition, "d");
    let definition = await this.em
      .createQueryBuilder(d)
      .where(d.projectId.eq(projectId))
      .forUpdate()
      .getOne();
    if (!definition) {
      // Lazily seed if this is the first transition the project ever sees.
      ({ definition } = await this.getOrSeed(projectId));
    }

    const rule = await this.transitions.findOne({
      where: {
        definitionId: definition.id,
        fromState,
        toState,
      },
    });
    if (!rule) {
      throw new WorkflowViolationException({
        code: "WORKFLOW_VIOLATION",
        rule: "TRANSITION_NOT_ALLOWED",
        fromState,
        toState,
      });
    }

    if (rule.requiredRole && !roleSatisfies(userRole, rule.requiredRole)) {
      throw new WorkflowViolationException({
        code: "WORKFLOW_VIOLATION",
        rule: "INSUFFICIENT_ROLE",
        fromState,
        toState,
        requiredRole: rule.requiredRole,
      });
    }

    if (rule.requiredFields && rule.requiredFields.length > 0) {
      const missing = rule.requiredFields.filter((field) => {
        const v = patchedIssue[field];
        return v === undefined || v === null || v === "";
      });
      if (missing.length > 0) {
        throw new WorkflowViolationException({
          code: "WORKFLOW_VIOLATION",
          rule: "REQUIRED_FIELDS_MISSING",
          fromState,
          toState,
          missing,
        });
      }
    }
  }
}
