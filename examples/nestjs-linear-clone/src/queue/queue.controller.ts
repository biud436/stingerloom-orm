import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseIntPipe,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBody, ApiQuery } from "@nestjs/swagger";
import { IsString, IsInt, Matches } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { QueueService } from "./queue.service";

class ClaimDto {
  @ApiProperty({ example: "worker-1" })
  @IsString()
  @Matches(/^[a-zA-Z0-9-]{1,64}$/)
  workerId!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  projectId!: number;
}

class ReleaseDto {
  @ApiProperty({ example: "worker-1" })
  @IsString()
  @Matches(/^[a-zA-Z0-9-]{1,64}$/)
  workerId!: string;
}

@ApiTags("Queue")
@Controller("queue")
export class QueueController {
  constructor(private readonly service: QueueService) {}

  @Post("claim")
  @ApiOperation({
    summary: "Claim the next available issue (FOR UPDATE SKIP LOCKED)",
    description:
      "Concurrent workers each receive a different issue. Returns 200 with `null` when the queue is empty.",
  })
  @ApiBody({ type: ClaimDto })
  claim(@Body() dto: ClaimDto) {
    return this.service.claimNext(dto.workerId, dto.projectId);
  }

  @Post("release/:issueId")
  @ApiOperation({ summary: "Release a previously claimed issue" })
  @ApiBody({ type: ReleaseDto })
  async release(
    @Param("issueId", ParseIntPipe) issueId: number,
    @Body() dto: ReleaseDto,
  ): Promise<{ released: boolean }> {
    const released = await this.service.release(dto.workerId, issueId);
    return { released };
  }

  @Get("stats/:projectId")
  @ApiOperation({ summary: "Queue depth and lease state per project" })
  @ApiQuery({ name: "projectId", required: true })
  stats(@Param("projectId", ParseIntPipe) projectId: number) {
    return this.service.stats(projectId);
  }
}
