import {
  Controller,
  Get,
  Post,
  Param,
  ParseIntPipe,
  Headers,
  Req,
  HttpCode,
  BadRequestException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation, ApiBody } from "@nestjs/swagger";
import type { Request } from "express";
import { ImportExportService } from "./import-export.service";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

const MAX_CSV_BYTES = 5 * 1024 * 1024;

@ApiTags("ImportExport")
@ApiBearerAuth()
@Controller()
export class ImportExportController {
  constructor(private readonly service: ImportExportService) {}

  /**
   * CSV import. The body is `text/csv` raw bytes — we use the express raw
   * reader rather than a multer pipeline because the example focuses on
   * `insertMany` chunked transactions, not on multipart upload mechanics.
   *
   * The request must declare Content-Type starting with `text/csv` and the
   * payload must be ≤ MAX_CSV_BYTES to prevent a single huge upload from
   * blowing past the example's heap budget.
   */
  @Post("projects/:id/issues/import")
  @WorkspaceScoped({ from: "project" })
  @HttpCode(200)
  @ApiOperation({
    summary: "Bulk-import issues from CSV (insertMany, chunked)",
    description: "CSV body with header row. Required: title. Optional: status, priority, estimate.",
  })
  @ApiBody({ schema: { type: "string", example: "title,status\nFix login,BACKLOG" } })
  async importIssues(
    @Param("id", ParseIntPipe) projectId: number,
    @CurrentUserId() userId: number,
    @Headers("content-type") contentType: string | undefined,
    @Req() req: Request,
  ) {
    if (!contentType || !contentType.toLowerCase().startsWith("text/csv")) {
      throw new BadRequestException("Content-Type must be text/csv");
    }
    const csv = await readBody(req, MAX_CSV_BYTES);
    return this.service.importIssues(projectId, csv, userId);
  }

  /**
   * Streaming JSON export of an entire workspace. See service for details
   * on the `stream()` AsyncGenerator usage.
   */
  @Get("workspaces/:id/export.json")
  @WorkspaceScoped({ from: "param", name: "id" })
  @ApiOperation({ summary: "JSON export of an entire workspace (streamed)" })
  exportWorkspace(@Param("id", ParseIntPipe) id: number) {
    return this.service.exportWorkspace(id);
  }
}

/**
 * Read the raw request body up to `maxBytes`. We do not rely on Nest's
 * body parser for `text/csv` because the default JSON parser swallows it.
 *
 * If a global parser is later added for `text/csv`, this should switch to
 * `req.body` directly.
 */
function readBody(req: Request, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(
          new BadRequestException(`CSV body exceeds ${maxBytes} bytes`),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
