import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Headers,
  ParseIntPipe,
} from "@nestjs/common";
import { UsersService } from "./users.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(
    @Headers("x-tenant-id") tenantId: string,
    @Body() dto: CreateUserDto,
  ) {
    return this.usersService.create(tenantId || "public", dto);
  }

  @Get()
  findAll(@Headers("x-tenant-id") tenantId: string) {
    return this.usersService.findAll(tenantId || "public");
  }

  @Get(":id")
  findOne(
    @Headers("x-tenant-id") tenantId: string,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.usersService.findOne(tenantId || "public", id);
  }

  @Patch(":id")
  update(
    @Headers("x-tenant-id") tenantId: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(tenantId || "public", id, dto);
  }

  @Delete(":id")
  remove(
    @Headers("x-tenant-id") tenantId: string,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.usersService.remove(tenantId || "public", id);
  }
}
