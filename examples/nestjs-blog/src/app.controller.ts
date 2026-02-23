import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";
import {
  SchemaDiff,
  SchemaDiffMigrationGenerator,
  SchemaDiffResult,
} from "stingerloom-orm";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * GET /schema/diff — SchemaDiff demo.
   * Returns the SchemaDiff and SchemaDiffMigrationGenerator capabilities.
   * In a real scenario, this would compare entity metadata against the live DB.
   */
  @Get("schema/diff")
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
