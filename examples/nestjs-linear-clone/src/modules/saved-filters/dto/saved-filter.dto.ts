import { ApiProperty } from "@nestjs/swagger";
import {
  IsInt,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * Comparison ops over a single field. Values are bound as parameters; the
 * field name is enforced by the allowlist in `compile-filter.ts`.
 */
export type FilterOp =
  | { field: string; op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; value: unknown }
  | { field: string; op: "in" | "any"; value: unknown[] }
  | { field: string; op: "isNull" | "isNotNull" }
  | { field: string; op: "me" }
  | { field: string; op: "like"; value: string }
  | {
      field: string;
      op: "jsonEq";
      path: string[];
      value: unknown;
    };

export type SavedFilterDefinition =
  | { and: SavedFilterDefinition[] }
  | { or: SavedFilterDefinition[] }
  | { not: SavedFilterDefinition }
  | FilterOp;

export class CreateSavedFilterDto {
  @ApiProperty({ example: "My open bugs" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiProperty({
    description:
      "JQL-like AST. See SavedFilterDefinition for the allowed shape.",
    example: {
      and: [
        { field: "status", op: "eq", value: "BACKLOG" },
        { field: "assigneeId", op: "me" },
      ],
    },
  })
  @IsObject()
  definition!: SavedFilterDefinition;

  @ApiProperty({ required: false, example: 1 })
  @IsInt()
  workspaceId!: number;
}
