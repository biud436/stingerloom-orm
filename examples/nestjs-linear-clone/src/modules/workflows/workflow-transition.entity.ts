import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  CreateTimestamp,
} from "@stingerloom/orm";
import { MembershipRole } from "../../common/enums";

// Composite-PK transition rule keyed by (definitionId, fromState, toState) — the only entity in this example that exercises @PrimaryColumn.
@Entity()
@Index(["definition_id", "from_state"])
export class WorkflowTransition {
  @PrimaryColumn({ name: "definition_id", type: "int" })
  definitionId!: number;

  @PrimaryColumn({ name: "from_state", length: 32 })
  fromState!: string;

  @PrimaryColumn({ name: "to_state", length: 32 })
  toState!: string;

  @Column({ length: 16, nullable: true })
  requiredRole!: MembershipRole | null;

  @Column({ type: "json", nullable: true })
  requiredFields!: string[] | null;

  @CreateTimestamp()
  createdAt!: Date;
}
