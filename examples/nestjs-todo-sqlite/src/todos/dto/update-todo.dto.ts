import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class UpdateTodoDto {
  @ApiPropertyOptional({
    description: '할 일 제목',
    example: 'Buy milk (done)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: '할 일 설명',
    example: 'Got 2% milk',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: '완료 여부', example: true })
  @IsBoolean()
  @IsOptional()
  completed?: boolean;
}
