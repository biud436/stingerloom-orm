import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Query,
  HttpCode,
  BadRequestException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { WebhooksService } from "./webhooks.service";
import { WebhookDeliveryWorker } from "./webhook-worker.service";
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
} from "./dto/webhook.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Webhooks")
@ApiBearerAuth()
@Controller("webhooks")
export class WebhooksController {
  constructor(
    private readonly service: WebhooksService,
    private readonly worker: WebhookDeliveryWorker,
  ) {}

  // ── Endpoint CRUD ───────────────────────────────────────

  @Post("endpoints")
  @WorkspaceScoped({ from: "body", name: "workspaceId" })
  @ApiOperation({ summary: "Register a webhook endpoint" })
  createEndpoint(@Body() dto: CreateWebhookEndpointDto) {
    return this.service.createEndpoint(dto);
  }

  @Get("endpoints")
  @WorkspaceScoped({ from: "query", name: "workspaceId" })
  list(@Query("workspaceId") workspaceId?: string) {
    if (!workspaceId) {
      throw new BadRequestException("workspaceId query param is required");
    }
    return this.service.listEndpoints(Number(workspaceId));
  }

  @Get("endpoints/:id")
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findEndpoint(id);
  }

  @Patch("endpoints/:id")
  @WorkspaceScoped({ from: "body", name: "workspaceId" })
  @ApiOperation({
    summary:
      "Update a webhook endpoint (requires workspaceId in the body for workspace scoping)",
  })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.service.updateEndpoint(id, dto);
  }

  @Delete("endpoints/:id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.deleteEndpoint(id);
  }

  // ── Delivery actions ────────────────────────────────────

  @Post("deliveries/:id/replay")
  @ApiOperation({
    summary: "Re-queue a delivery (resets state to pending, attempt counter preserved)",
  })
  replay(@Param("id", ParseIntPipe) id: number) {
    return this.service.replayDelivery(id);
  }

  @Post("_tick")
  @ApiOperation({
    summary: "Manually run the delivery worker once (also used by tests)",
  })
  tick(@Query("batch") batch?: string) {
    const size = batch ? Math.max(1, Math.min(Number(batch), 64)) : 16;
    return this.worker.tick(size);
  }
}
