import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from "@nestjs/swagger";
import { CategoriesService } from "./categories.service";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";

@ApiTags("Categories")
@Controller("categories")
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @ApiOperation({ summary: "Create a category", description: "Create a new category." })
  @ApiResponse({ status: 201, description: "Category created successfully" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "Get all categories", description: "Retrieve all categories." })
  @ApiResponse({ status: 200, description: "List of categories" })
  findAll() {
    return this.categoriesService.findAll();
  }

  @Get("count")
  @ApiOperation({ summary: "Count categories", description: "Return total number of categories." })
  @ApiResponse({ status: 200, description: "Category count as number" })
  count() {
    return this.categoriesService.count();
  }

  /** GET /categories/stats -- GROUP BY + HAVING demo (카테고리별 포스트 수) */
  @Get("stats")
  @ApiOperation({
    summary: "Category stats (GROUP BY + HAVING)",
    description:
      "카테고리별 포스트 수를 GROUP BY + HAVING으로 집계합니다. " +
      "포스트가 1개 이상인 카테고리만 반환합니다.",
  })
  @ApiResponse({
    status: 200,
    description: "Array of { name, postCount } for categories with at least one post",
  })
  getStats() {
    return this.categoriesService.getStats();
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a category by ID", description: "Retrieve a single category by ID." })
  @ApiParam({ name: "id", type: Number, description: "Category ID", example: 1 })
  @ApiResponse({ status: 200, description: "Category found" })
  @ApiResponse({ status: 404, description: "Category not found" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.categoriesService.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a category", description: "Update a category by ID." })
  @ApiParam({ name: "id", type: Number, description: "Category ID", example: 1 })
  @ApiResponse({ status: 200, description: "Category updated successfully" })
  @ApiResponse({ status: 404, description: "Category not found" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a category", description: "Permanently delete a category by ID." })
  @ApiParam({ name: "id", type: Number, description: "Category ID", example: 1 })
  @ApiResponse({ status: 200, description: "Category deleted" })
  @ApiResponse({ status: 404, description: "Category not found" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.categoriesService.remove(id);
  }
}
