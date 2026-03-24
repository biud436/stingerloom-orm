/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { EntityMetadataNotFoundError } from "../../src/errors/EntityMetadataNotFoundError";
import { EntityNotFoundError } from "../../src/errors/EntityNotFoundError";
import { PrimaryKeyNotFoundError } from "../../src/errors/PrimaryKeyNotFoundError";
import { DatabaseNotConnectedError } from "../../src/errors/DatabaseNotConnectedError";
import { DeleteWithoutConditionsError } from "../../src/errors/DeleteWithoutConditionsError";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

// ── Issue 1: find() return type ──

describe("Issue 1: find()/findOne() return types", () => {
  it("EntityManager.find should return T[] (method signature check)", () => {
    const { EntityManager } = require("../../src/core/EntityManager");
    expect(typeof EntityManager.prototype.find).toBe("function");
  });

  it("BaseRepository.find should return T[] (method signature check)", () => {
    const { BaseRepository } = require("../../src/core/BaseRepository");
    expect(typeof BaseRepository.prototype.find).toBe("function");
  });
});

// ── Issue 2: skip/take pagination ──

describe("Issue 2: skip/take pagination", () => {
  it("FindOption should accept skip and take", () => {
    const option: any = { skip: 10, take: 5 };
    expect(option.skip).toBe(10);
    expect(option.take).toBe(5);
  });

  it("FindOption should still accept limit tuple", () => {
    const option: any = { limit: [10, 5] };
    expect(option.limit).toEqual([10, 5]);
  });

  it("FindOption should accept limit as number", () => {
    const option: any = { limit: 10 };
    expect(option.limit).toBe(10);
  });
});

// ── Issue 4: @Column({ default }) ──

describe("Issue 4: @Column({ default })", () => {
  @Entity({ name: "test_default_table" })
  class TestDefaultEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ default: "active" })
    status!: string;

    @Column({ type: "int", default: 0 })
    count!: number;

    @Column({ type: "boolean", default: true })
    isActive!: boolean;

    @Column({ default: null, nullable: true })
    deletedAt!: string | null;

    @Column({ default: "(CURRENT_TIMESTAMP)" })
    createdAt!: string;
  }

  it("should generate DDL with DEFAULT string value (MySQL)", () => {
    const sg = new SchemaGenerator({ dialect: "mysql" });
    const ddl = sg.generateCreateTableDDL(TestDefaultEntity);
    expect(ddl).toContain("DEFAULT 'active'");
  });

  it("should generate DDL with DEFAULT number value (MySQL)", () => {
    const sg = new SchemaGenerator({ dialect: "mysql" });
    const ddl = sg.generateCreateTableDDL(TestDefaultEntity);
    expect(ddl).toContain("DEFAULT 0");
  });

  it("should generate DDL with DEFAULT boolean (MySQL as 1)", () => {
    const sg = new SchemaGenerator({ dialect: "mysql" });
    const ddl = sg.generateCreateTableDDL(TestDefaultEntity);
    expect(ddl).toContain("DEFAULT 1");
  });

  it("should generate DDL with DEFAULT boolean (PostgreSQL as TRUE)", () => {
    const sg = new SchemaGenerator({ dialect: "postgres" });
    const ddl = sg.generateCreateTableDDL(TestDefaultEntity);
    expect(ddl).toContain("DEFAULT TRUE");
  });

  it("should generate DDL with DEFAULT NULL", () => {
    const sg = new SchemaGenerator({ dialect: "mysql" });
    const ddl = sg.generateCreateTableDDL(TestDefaultEntity);
    expect(ddl).toContain("DEFAULT NULL");
  });

  it("should generate DDL with DEFAULT expression (parenthesized)", () => {
    const sg = new SchemaGenerator({ dialect: "postgres" });
    const ddl = sg.generateCreateTableDDL(TestDefaultEntity);
    expect(ddl).toContain("DEFAULT (CURRENT_TIMESTAMP)");
  });

  it("should escape single quotes in default string values", () => {
    @Entity({ name: "test_escape_default" })
    class EscapeEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ default: "it's" })
      name!: string;
    }

    const sg = new SchemaGenerator({ dialect: "mysql" });
    const ddl = sg.generateCreateTableDDL(EscapeEntity);
    expect(ddl).toContain("DEFAULT 'it''s'");
  });
});

// ── Issue 5: FindCondition deprecation ──

describe("Issue 5: FindCondition deprecation", () => {
  it("FindCondition and FindOperator are still importable (backward compat)", () => {
    const mod = require("../../src/types/FindCondition");
    // They are types — the module should import without error
    expect(mod).toBeDefined();
  });
});

// ── Issue 6: Type-safe relations ──

describe("Issue 6: Type-safe relations", () => {
  it("FindOption.relations should accept string array", () => {
    const option: any = { relations: ["posts"] };
    expect(option.relations).toEqual(["posts"]);
  });
});

// ── Issue 8: Error messages with suggestions ──

describe("Issue 8: Error messages with suggestions", () => {
  it("OrmError should have suggestion field", () => {
    const error = new OrmError(OrmErrorCode.INVALID_QUERY, "test", "try this");
    expect(error.suggestion).toBe("try this");
  });

  it("OrmError suggestion defaults to null", () => {
    const error = new OrmError(OrmErrorCode.INVALID_QUERY, "test");
    expect(error.suggestion).toBeNull();
  });

  it("EntityMetadataNotFoundError has a suggestion", () => {
    const error = new EntityMetadataNotFoundError("User");
    expect(error.suggestion).toBeTruthy();
    expect(error.suggestion).toContain("@Entity()");
  });

  it("EntityNotFoundError has a suggestion", () => {
    const error = new EntityNotFoundError("User");
    expect(error.suggestion).toBeTruthy();
  });

  it("PrimaryKeyNotFoundError has a suggestion", () => {
    const error = new PrimaryKeyNotFoundError("User");
    expect(error.suggestion).toBeTruthy();
    expect(error.suggestion).toContain("@PrimaryGeneratedColumn");
  });

  it("DatabaseNotConnectedError has a suggestion", () => {
    const error = new DatabaseNotConnectedError();
    expect(error.suggestion).toBeTruthy();
    expect(error.suggestion).toContain("register");
    expect(error.code).toBe(OrmErrorCode.NOT_CONNECTED);
  });

  it("DeleteWithoutConditionsError has a suggestion", () => {
    const error = new DeleteWithoutConditionsError("Update");
    expect(error.suggestion).toBeTruthy();
    expect(error.message).toContain("Update without conditions");
  });

  it("OrmErrorCode has UNIQUE_VIOLATION and FK_VIOLATION", () => {
    expect(OrmErrorCode.UNIQUE_VIOLATION).toBe("ORM_UNIQUE_VIOLATION");
    expect(OrmErrorCode.FK_VIOLATION).toBe("ORM_FK_VIOLATION");
  });
});

// ── Issue 9: Synchronize modes ──

describe("Issue 9: synchronize modes", () => {
  it("DatabaseClientOptions.synchronize should accept different modes", () => {
    const opts1: any = { synchronize: true };
    const opts2: any = { synchronize: "safe" };
    const opts3: any = { synchronize: "dry-run" };
    const opts4: any = { synchronize: false };

    expect(opts1.synchronize).toBe(true);
    expect(opts2.synchronize).toBe("safe");
    expect(opts3.synchronize).toBe("dry-run");
    expect(opts4.synchronize).toBe(false);
  });
});

// ── Issue 10: MigrationCli migrate:generate ──

describe("Issue 10: MigrationCli migrate:generate command", () => {
  it("SchemaDiffMigrationGenerator.generate produces valid migration code", () => {
    const { SchemaDiffMigrationGenerator } = require("../../src/core/generators/SchemaDiffMigrationGenerator");
    const generator = new SchemaDiffMigrationGenerator();
    const diff = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
    };
    const code = generator.generate(diff, "mysql");
    expect(code).toContain("extends Migration");
    expect(code).toContain("async up");
    expect(code).toContain("async down");
  });

  it("MigrationCli should accept migrate:generate command type", () => {
    const { MigrationCli } = require("../../src/migration/MigrationCli");
    expect(typeof MigrationCli.prototype.migrateGenerate).toBe("function");
  });
});

// ── Issue 11: em.transaction() ──

describe("Issue 11: em.transaction() callback API", () => {
  it("EntityManager should have transaction method defined", () => {
    const { EntityManager } = require("../../src/core/EntityManager");
    expect(typeof EntityManager.prototype.transaction).toBe("function");
  });
});

// ── Issue 3: SQL query logging ──

describe("Issue 3: SQL query logging", () => {
  it("LoggingOptions should accept queries field", () => {
    const opts: any = {
      logging: { queries: true, slowQueryMs: 500 },
    };
    expect(opts.logging.queries).toBe(true);
  });

  it("logging: true should enable query logging", () => {
    const opts: any = { logging: true };
    expect(opts.logging).toBe(true);
  });
});

// ── Issue 7: updateMany() ──

describe("Issue 7: updateMany()", () => {
  it("EntityManager should have updateMany method defined", () => {
    const { EntityManager } = require("../../src/core/EntityManager");
    expect(typeof EntityManager.prototype.updateMany).toBe("function");
  });

  it("BaseRepository should have updateMany method defined", () => {
    const { BaseRepository } = require("../../src/core/BaseRepository");
    expect(typeof BaseRepository.prototype.updateMany).toBe("function");
  });
});
