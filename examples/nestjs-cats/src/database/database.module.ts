import { DynamicModule, Module } from "@nestjs/common";
import { DatabaseService, DATABASE_SERVICE_TOKEN } from "./database.service";
import type { DatabaseClientOptions } from "stingerloom-orm";

export type { DatabaseClientOptions } from "stingerloom-orm";

export const DATABASE_OPTION_TOKEN = Symbol.for("DATABASE_OPTION_TOKEN");

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseClientOptions): DynamicModule {
    // Store configuration in metadata
    Reflect.defineMetadata(DATABASE_OPTION_TOKEN, options, DatabaseModule);

    // Mark this module as captured for initialization
    DatabaseService.captured[DATABASE_SERVICE_TOKEN] = true;

    return {
      module: DatabaseModule,
      providers: [DatabaseService],
      exports: [DatabaseService],
      global: true,
    };
  }
}
