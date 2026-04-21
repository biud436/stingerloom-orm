import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@ApiTags("Users")
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: "Create a user", description: "Create a new user account." })
  @ApiResponse({ status: 201, description: "User created successfully" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "Get all users", description: "Retrieve all users." })
  @ApiResponse({ status: 200, description: "List of users" })
  findAll() {
    return this.usersService.findAll();
  }

  /** findAndCount -- pagination */
  @Get("paginated")
  @ApiOperation({
    summary: "Paginated user list",
    description: "findAndCount 기반 페이지네이션. Returns data, total, page, totalPages.",
  })
  @ApiQuery({ name: "page", required: false, type: Number, description: "Page number (default: 1)", example: 1 })
  @ApiQuery({ name: "limit", required: false, type: Number, description: "Items per page (default: 10)", example: 10 })
  @ApiResponse({ status: 200, description: "Paginated user list with total count" })
  findPaginated(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.usersService.findPaginated(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get("count")
  @ApiOperation({ summary: "Count users", description: "Return total number of users." })
  @ApiResponse({ status: 200, description: "User count as number" })
  count() {
    return this.usersService.count();
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a user by ID", description: "Retrieve a single user by ID." })
  @ApiParam({ name: "id", type: Number, description: "User ID", example: 1 })
  @ApiResponse({ status: 200, description: "User found" })
  @ApiResponse({ status: 404, description: "User not found" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a user", description: "Update a user by ID." })
  @ApiParam({ name: "id", type: Number, description: "User ID", example: 1 })
  @ApiResponse({ status: 200, description: "User updated successfully" })
  @ApiResponse({ status: 404, description: "User not found" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a user", description: "Permanently delete a user by ID." })
  @ApiParam({ name: "id", type: Number, description: "User ID", example: 1 })
  @ApiResponse({ status: 200, description: "User deleted" })
  @ApiResponse({ status: 404, description: "User not found" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.remove(id);
  }
}
