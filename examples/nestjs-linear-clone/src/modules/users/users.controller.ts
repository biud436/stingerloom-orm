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
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { CreateUserDto, UpdateUserDto } from "./dto/user.dto";
import { CursorQueryDto } from "../../common/dto/cursor.dto";

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
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
