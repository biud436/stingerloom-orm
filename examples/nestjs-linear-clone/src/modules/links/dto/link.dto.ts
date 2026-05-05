import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsIn, Min } from "class-validator";

export const LINK_TYPES = ["blocks", "blockedBy", "relatesTo", "duplicates"] as const;
export type LinkTypeLiteral = (typeof LINK_TYPES)[number];

export class CreateLinkDto {
  @ApiProperty({ example: 42 })
  @IsInt()
  @Min(1)
  targetId!: number;

  @ApiProperty({ enum: LINK_TYPES, example: "blocks" })
  @IsIn(LINK_TYPES as readonly string[])
  type!: LinkTypeLiteral;
}

export interface IssueLinkRow {
  id: number;
  number: number;
  title: string;
  status: string;
  depth: number;
}
