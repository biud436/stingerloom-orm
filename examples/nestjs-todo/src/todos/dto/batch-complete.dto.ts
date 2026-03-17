import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsInt, ArrayMinSize } from "class-validator";

export class BatchCompleteDto {
  @ApiProperty({
    description: "완료 처리할 할 일 ID 배열",
    example: [1, 2, 3],
    type: [Number],
  })
  @IsArray()
  @IsInt({ each: true })
  @ArrayMinSize(1)
  ids!: number[];
}
