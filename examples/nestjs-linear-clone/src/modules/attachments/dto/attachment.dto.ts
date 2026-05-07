import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsPositive, IsString, MaxLength, MinLength } from "class-validator";

export class CreateAttachmentDto {
  @ApiProperty({ description: "Original filename" })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ description: "MIME type" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  contentType!: string;

  @ApiProperty({ description: "Size in bytes (must be > 0)" })
  @IsInt()
  @IsPositive()
  sizeBytes!: number;

  @ApiProperty({ description: "Opaque storage URL (s3://, gs://, https://)" })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  storageUrl!: string;
}
