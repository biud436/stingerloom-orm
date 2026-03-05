import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, ArrayNotEmpty, ValidateNested } from "class-validator";
import { CreateCatDto } from "./create-cat.dto";

export class BulkCreateCatDto {
  @ApiProperty({
    description: "생성할 고양이 배열",
    type: [CreateCatDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateCatDto)
  cats!: CreateCatDto[];
}
