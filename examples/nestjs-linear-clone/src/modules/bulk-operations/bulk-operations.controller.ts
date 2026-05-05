import { Controller, Post, Body, Req } from "@nestjs/common";
import { Request } from "express";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { BulkOperationsService } from "./bulk-operations.service";
import { BulkUpdateIssuesDto } from "./dto/bulk.dto";
import { CurrentUserId } from "../../common/auth/current-user.decorator";

@ApiTags("Bulk")
@ApiBearerAuth()
@Controller("issues/bulk")
export class BulkOperationsController {
  constructor(private readonly service: BulkOperationsService) {}

  @Post()
  @ApiOperation({
    summary:
      "Per-row optimistic update under one BulkOperation envelope. " +
      "Each row reports outcome (ok | conflict | not_found | error); a single " +
      "stale row does not roll back the others. Idempotent under " +
      "Idempotency-Key (handled by the global interceptor).",
  })
  bulkUpdate(
    @Body() dto: BulkUpdateIssuesDto,
    @CurrentUserId() userId: number,
    @Req() req: Request,
  ) {
    const idempotencyKey = req.header("idempotency-key") ?? null;
    return this.service.bulkUpdate(dto, userId, idempotencyKey);
  }
}
