import { ApiProperty } from "@nestjs/swagger";
import { IsArray, ArrayNotEmpty, IsInt, Min } from "class-validator";
import { Type } from "class-transformer";

export class BulkDeleteCatDto {
  @ApiProperty({
    description: "삭제할 고양이 ID 배열",
    example: [1, 2, 3],
    type: [Number],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Type(() => Number)
  ids!: number[];
}
