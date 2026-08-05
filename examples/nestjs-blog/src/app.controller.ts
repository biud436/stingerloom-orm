import { Controller, Get, Inject } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AppService } from "./app.service";
import {
  EntityManager,
  SchemaDiff,
  SchemaDiffMigrationGenerator,
  SchemaDiffResult,
} from "@stingerloom/orm";
import { User } from "./users/user.entity";
import { Post } from "./posts/post.entity";
import { Tag } from "./tags/tag.entity";
import { Category } from "./categories/category.entity";

@ApiTags("App")
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Get()
  @ApiOperation({ summary: "Health check", description: "Returns a welcome message with available API routes." })
  @ApiResponse({ status: 200, description: "Welcome message string" })
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * GET /schema/diff — compares the registered entity metadata against the
   * live database's INFORMATION_SCHEMA and returns the real diff, plus the
   * up/down SQL a generated migration would run.
   */
  @Get("schema/diff")
  @ApiOperation({
    summary: "Schema diff against the live database",
    description:
      "Runs SchemaDiff.diff() with the app's entities against the connected " +
      "MySQL database and returns the detected changes. When changes exist, " +
      "migrationPreview carries the up/down SQL from " +
      "SchemaDiffMigrationGenerator.dryRun(). With synchronize enabled the " +
      "diff is normally empty.",
  })
  @ApiResponse({
    status: 200,
    description: "Real SchemaDiffResult and the migration SQL preview",
  })
  async getSchemaDiff(): Promise<{
    inSync: boolean;
    diff: SchemaDiffResult;
    migrationPreview: { up: string[]; down: string[] };
  }> {
    const schemaDiff = new SchemaDiff();
    const diff = await schemaDiff.diff(
      [User, Post, Tag, Category],
      { query: (sql) => this.em.query(sql as string) },
      "mysql",
    );

    const hasChanges =
      diff.addTables.length > 0 ||
      diff.dropTables.length > 0 ||
      diff.addColumns.length > 0 ||
      diff.dropColumns.length > 0 ||
      diff.alterColumns.length > 0 ||
      (diff.renamedColumns?.length ?? 0) > 0;

    const migrationPreview = hasChanges
      ? new SchemaDiffMigrationGenerator().dryRun(diff, "mysql")
      : { up: [], down: [] };

    return { inSync: !hasChanges, diff, migrationPreview };
  }
}
