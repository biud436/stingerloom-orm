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
  ApiSecurity,
} from "@nestjs/swagger";
import { PostsService } from "./posts.service";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";

@ApiTags("Posts")
@Controller("posts")
@ApiSecurity("x-tenant-id")
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  @ApiOperation({
    summary: "게시글 생성",
    description: "새로운 게시글을 생성합니다.",
  })
  @ApiResponse({ status: 201, description: "게시글이 성공적으로 생성됨" })
  @ApiResponse({ status: 400, description: "잘못된 요청 데이터" })
  create(@Body() dto: CreatePostDto) {
    return this.postsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: "전체 게시글 조회",
    description:
      "현재 테넌트의 모든 게시글을 조회합니다. 작성자(author) 정보가 eager 로딩됩니다.",
  })
  @ApiResponse({ status: 200, description: "게시글 목록 반환" })
  findAll() {
    return this.postsService.findAll();
  }

  @Get(":id")
  @ApiOperation({
    summary: "게시글 단건 조회",
    description: "ID로 특정 게시글을 조회합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "게시글 ID" })
  @ApiResponse({ status: 200, description: "게시글 정보 반환" })
  @ApiResponse({ status: 404, description: "게시글을 찾을 수 없음" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "게시글 수정",
    description: "ID로 특정 게시글의 정보를 수정합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "게시글 ID" })
  @ApiResponse({ status: 200, description: "수정된 게시글 정보 반환" })
  @ApiResponse({ status: 404, description: "게시글을 찾을 수 없음" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdatePostDto) {
    return this.postsService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({
    summary: "게시글 삭제",
    description: "ID로 특정 게시글을 삭제합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "게시글 ID" })
  @ApiResponse({ status: 200, description: "게시글 삭제 완료" })
  @ApiResponse({ status: 404, description: "게시글을 찾을 수 없음" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.remove(id);
  }
}
