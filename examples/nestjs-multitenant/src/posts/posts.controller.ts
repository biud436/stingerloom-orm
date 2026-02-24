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
import { PostsService } from "./posts.service";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";

@Controller("posts")
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  create(
    @Headers("x-tenant-id") tenantId: string,
    @Body() dto: CreatePostDto,
  ) {
    return this.postsService.create(tenantId || "public", dto);
  }

  @Get()
  findAll(@Headers("x-tenant-id") tenantId: string) {
    return this.postsService.findAll(tenantId || "public");
  }

  @Get(":id")
  findOne(
    @Headers("x-tenant-id") tenantId: string,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.postsService.findOne(tenantId || "public", id);
  }

  @Patch(":id")
  update(
    @Headers("x-tenant-id") tenantId: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdatePostDto,
  ) {
    return this.postsService.update(tenantId || "public", id, dto);
  }

  @Delete(":id")
  remove(
    @Headers("x-tenant-id") tenantId: string,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.postsService.remove(tenantId || "public", id);
  }
}
