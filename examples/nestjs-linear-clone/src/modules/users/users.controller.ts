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
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { CreateUserDto, UpdateUserDto } from "./dto/user.dto";
import { CursorQueryDto } from "../../common/dto/cursor.dto";
import { CurrentUserId } from "../../common/auth/current-user.decorator";

@ApiTags("Users")
@Controller("users")
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "List users (capped at 50; use /users/cursor for full pagination)" })
  list(@Query("limit") limit?: string) {
    return this.service.findAll(limit ? Number(limit) : undefined);
  }

  @Get("cursor")
  @ApiOperation({ summary: "Cursor-paginated user list (stable ascending by id)" })
  cursor(@Query() q: CursorQueryDto) {
    return this.service.findWithCursor(q.take ?? 20, q.cursor);
  }

  @Get(":id")
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update your own profile (self only)" })
  update(
    @CurrentUserId() actorId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    // Users are a global directory, so there is no workspace to scope against.
    // Object-level authorization here is self-only: without it any authed user
    // could rename or delete any account by id.
    if (id !== actorId) {
      throw new ForbiddenException("You may only update your own profile");
    }
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete your own account (self only)" })
  remove(@CurrentUserId() actorId: number, @Param("id", ParseIntPipe) id: number) {
    if (id !== actorId) {
      throw new ForbiddenException("You may only delete your own account");
    }
    return this.service.remove(id);
  }
}
