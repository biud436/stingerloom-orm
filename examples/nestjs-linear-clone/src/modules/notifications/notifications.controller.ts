import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  ParseIntPipe,
  Query,
  HttpCode,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { NotificationsService } from "./notifications.service";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CursorQueryDto } from "../../common/dto/cursor.dto";

/**
 * Two surfaces share the controller because both are notification-domain:
 *   - /issues/:id/watch[ers]  — opt-in/out of an issue's notification stream
 *   - /inbox                  — read the current user's notification feed
 */
@ApiTags("Notifications")
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  // ── Watchers (issue-scoped) ─────────────────────────────────

  @Post("issues/:id/watch")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Subscribe the current user to an issue's events" })
  watch(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUserId() userId: number,
  ) {
    return this.service.watch(id, userId);
  }

  @Delete("issues/:id/watch")
  @WorkspaceScoped({ from: "issue" })
  @HttpCode(204)
  @ApiOperation({ summary: "Unsubscribe the current user from an issue" })
  async unwatch(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUserId() userId: number,
  ) {
    await this.service.unwatch(id, userId);
  }

  @Get("issues/:id/watchers")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "List all watchers of an issue" })
  watchers(@Param("id", ParseIntPipe) id: number) {
    return this.service.watchersFor(id);
  }

  // ── Inbox (user-scoped) ─────────────────────────────────────

  @Get("inbox")
  @ApiOperation({ summary: "Cursor-paginated notification feed for the current user" })
  inbox(@CurrentUserId() userId: number, @Query() q: CursorQueryDto) {
    return this.service.inbox(userId, q.take ?? 20, q.cursor);
  }

  @Get("inbox/unread-count")
  @ApiOperation({ summary: "Number of unread notifications for the current user" })
  async unreadCount(@CurrentUserId() userId: number) {
    const count = await this.service.unreadCount(userId);
    return { count };
  }

  @Patch("inbox/:id/read")
  @ApiOperation({ summary: "Mark a single notification as read" })
  markRead(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUserId() userId: number,
  ) {
    return this.service.markRead(id, userId);
  }

  // Path lives outside `inbox/` so it cannot collide with `inbox/:id/read`
  // under path-to-regexp's matching — the earlier `inbox/read-all` shape
  // tripped ParseIntPipe even with route declaration order swapped.
  @Patch("inbox-read-all")
  @ApiOperation({ summary: "Mark every unread notification as read" })
  markAllRead(@CurrentUserId() userId: number) {
    return this.service.markAllRead(userId);
  }
}
