import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AppService } from "./app.service";
import {
  SchemaDiff,
  SchemaDiffMigrationGenerator,
  SchemaDiffResult,
} from "@stingerloom/orm";

@ApiTags("App")
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: "Health check", description: "Returns a welcome message with available API routes." })
  @ApiResponse({ status: 200, description: "Welcome message string" })
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * GET /schema/diff -- SchemaDiff demo.
   * Returns the SchemaDiff and SchemaDiffMigrationGenerator capabilities.
   * In a real scenario, this would compare entity metadata against the live DB.
   */
  @Get("schema/diff")
  @ApiOperation({
    summary: "Schema Diff demo",
    description:
      "Returns an empty SchemaDiffResult and a sample migration string. " +
      "In a real scenario, connect to a live DB and pass entities + queryRunner to diff() for real results.",
  })
  @ApiResponse({
    status: 200,
    description: "SchemaDiff result with empty diff and sample migration content",
  })
  getSchemaDiff(): {
    message: string;
    emptyDiff: SchemaDiffResult;
    sampleMigration: string;
  } {
    const diff = new SchemaDiff();
    const generator = new SchemaDiffMigrationGenerator();

    const emptyDiff: SchemaDiffResult = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
    };

    const sampleMigration = generator.generate(emptyDiff, "mysql");

    return {
      message:
        "SchemaDiff compares entity metadata with DB INFORMATION_SCHEMA. " +
        "Connect to a live DB and pass entities + queryRunner to diff() for real results.",
      emptyDiff,
      sampleMigration,
    };
  }
}
