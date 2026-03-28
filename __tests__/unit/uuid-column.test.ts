/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column, COLUMN_TOKEN } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { generateUUIDv7, extractTimestampFromUUIDv7 } from "../../src/utils/uuid-v7";

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
class UuidEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

@Entity()
class UuidV7Entity {
  @PrimaryGeneratedColumn("uuid-v7")
  id!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

@Entity()
class IncrementEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

@Entity()
class UuidColumnEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "uuid" })
  externalId!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

@Entity()
class ManualUuidEntity {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;
}

// ─────────────────────────────────────────────────
// Driver castType tests
// ─────────────────────────────────────────────────

describe("UUID ColumnType — Driver castType", () => {
  let mysqlDriver: MySqlDriver;
  let postgresDriver: PostgresDriver;
  let sqliteDriver: SqliteDriver;

  beforeAll(() => {
    mysqlDriver = new MySqlDriver({} as any, "mysql");
    postgresDriver = new PostgresDriver({} as any, "postgres");
    sqliteDriver = new SqliteDriver({} as any);
  });

  test("MySQL: uuid → CHAR(36)", () => {
    expect(mysqlDriver.castType("uuid")).toBe("CHAR(36)");
  });

  test("PostgreSQL: uuid → UUID", () => {
    expect(postgresDriver.castType("uuid")).toBe("UUID");
  });

  test("SQLite: uuid → VARCHAR(36)", () => {
    expect(sqliteDriver.castType("uuid")).toBe("VARCHAR(36)");
  });
});

// ─────────────────────────────────────────────────
// SchemaGenerator DDL tests
// ─────────────────────────────────────────────────

describe("UUID ColumnType — SchemaGenerator DDL", () => {
  test("MySQL: uuid PK column generates CHAR(36) NOT NULL PRIMARY KEY", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(UuidEntity);
    // Should contain CHAR(36) for UUID type
    expect(ddl).toContain("CHAR(36)");
    expect(ddl).toContain("PRIMARY KEY");
    expect(ddl).not.toContain("AUTO_INCREMENT");
    expect(ddl).not.toContain("SERIAL");
  });

  test("PostgreSQL: uuid PK column generates UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddl = gen.generateCreateTableDDL(UuidEntity);
    expect(ddl).toContain("UUID");
    expect(ddl).toContain("gen_random_uuid()");
    expect(ddl).toContain("PRIMARY KEY");
    expect(ddl).not.toContain("SERIAL");
  });

  test("SQLite: uuid PK column generates VARCHAR(36) NOT NULL PRIMARY KEY", () => {
    const gen = new SchemaGenerator({ dialect: "sqlite" });
    const ddl = gen.generateCreateTableDDL(UuidEntity);
    expect(ddl).toContain("VARCHAR(36)");
    expect(ddl).toContain("PRIMARY KEY");
    expect(ddl).not.toContain("AUTOINCREMENT");
  });

  test("MySQL: plain uuid column (non-PK) generates CHAR(36)", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(UuidColumnEntity);
    expect(ddl).toContain("CHAR(36)");
  });

  test("PostgreSQL: plain uuid column (non-PK) generates UUID", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddl = gen.generateCreateTableDDL(UuidColumnEntity);
    // Should have UUID for externalId but NOT gen_random_uuid (no generation strategy)
    expect(ddl).toMatch(/externalId.*UUID/i);
  });

  test("uuid-v7 PK should NOT get gen_random_uuid() on PostgreSQL", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddl = gen.generateCreateTableDDL(UuidV7Entity);
    expect(ddl).toContain("UUID");
    expect(ddl).not.toContain("gen_random_uuid()");
    expect(ddl).toContain("PRIMARY KEY");
  });

  test("Default increment PK still works", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(IncrementEntity);
    expect(ddl).toContain("AUTO_INCREMENT");
    expect(ddl).not.toContain("CHAR(36)");
  });
});

// ─────────────────────────────────────────────────
// PrimaryGeneratedColumn decorator metadata tests
// ─────────────────────────────────────────────────

describe("UUID ColumnType — PrimaryGeneratedColumn decorator metadata", () => {
  test("@PrimaryGeneratedColumn('uuid') sets correct metadata", () => {
    const columns = Reflect.getMetadata(COLUMN_TOKEN, UuidEntity.prototype);
    const idCol = columns.find((c: any) => c.name === "id");
    expect(idCol).toBeDefined();
    expect(idCol.options.type).toBe("uuid");
    expect(idCol.options.primary).toBe(true);
    expect(idCol.options.autoIncrement).toBe(false);
    expect(idCol.options.generationStrategy).toBe("uuid");
  });

  test("@PrimaryGeneratedColumn('uuid-v7') sets correct metadata", () => {
    const columns = Reflect.getMetadata(COLUMN_TOKEN, UuidV7Entity.prototype);
    const idCol = columns.find((c: any) => c.name === "id");
    expect(idCol).toBeDefined();
    expect(idCol.options.type).toBe("uuid");
    expect(idCol.options.primary).toBe(true);
    expect(idCol.options.autoIncrement).toBe(false);
    expect(idCol.options.generationStrategy).toBe("uuid-v7");
  });

  test("@PrimaryGeneratedColumn() (default) sets increment strategy", () => {
    const columns = Reflect.getMetadata(COLUMN_TOKEN, IncrementEntity.prototype);
    const idCol = columns.find((c: any) => c.name === "id");
    expect(idCol).toBeDefined();
    expect(idCol.options.type).toBe("int");
    expect(idCol.options.primary).toBe(true);
    expect(idCol.options.autoIncrement).toBe(true);
    expect(idCol.options.generationStrategy).toBe("increment");
  });

  test("@PrimaryColumn({ type: 'uuid' }) has no generationStrategy", () => {
    const columns = Reflect.getMetadata(COLUMN_TOKEN, ManualUuidEntity.prototype);
    const idCol = columns.find((c: any) => c.name === "id");
    expect(idCol).toBeDefined();
    expect(idCol.options.type).toBe("uuid");
    expect(idCol.options.primary).toBe(true);
    expect(idCol.options.generationStrategy).toBeUndefined();
  });

  test("@PrimaryGeneratedColumn('uuid', { name: 'custom_id' }) applies options", () => {
    @Entity()
    class CustomUuid {
      @PrimaryGeneratedColumn("uuid", { name: "custom_id" })
      id!: string;
    }
    const columns = Reflect.getMetadata(COLUMN_TOKEN, CustomUuid.prototype);
    const idCol = columns.find((c: any) => c.name === "custom_id");
    expect(idCol).toBeDefined();
    expect(idCol.options.type).toBe("uuid");
    expect(idCol.options.generationStrategy).toBe("uuid");
  });

  test("@PrimaryGeneratedColumn({ name: 'pk' }) backward compat — still increment", () => {
    @Entity()
    class LegacyOptions {
      @PrimaryGeneratedColumn({ name: "pk" })
      id!: number;
    }
    const columns = Reflect.getMetadata(COLUMN_TOKEN, LegacyOptions.prototype);
    const idCol = columns.find((c: any) => c.name === "pk");
    expect(idCol).toBeDefined();
    expect(idCol.options.type).toBe("int");
    expect(idCol.options.autoIncrement).toBe(true);
    expect(idCol.options.generationStrategy).toBe("increment");
  });
});

// ─────────────────────────────────────────────────
// UUIDv7 generation tests
// ─────────────────────────────────────────────────

describe("UUIDv7 generation", () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("generates valid UUIDv7 format", () => {
    const uuid = generateUUIDv7();
    expect(uuid).toMatch(UUID_REGEX);
  });

  test("version nibble is 7", () => {
    const uuid = generateUUIDv7();
    // 13th character (index 14 with hyphens) should be '7'
    expect(uuid[14]).toBe("7");
  });

  test("variant bits are 10xx", () => {
    const uuid = generateUUIDv7();
    // 17th hex char (index 19 with hyphens) should be 8, 9, a, or b
    expect(["8", "9", "a", "b"]).toContain(uuid[19]);
  });

  test("100 generated UUIDs are all unique", () => {
    const uuids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      uuids.add(generateUUIDv7());
    }
    expect(uuids.size).toBe(100);
  });

  test("monotonically increasing (lexicographic order ~ time order)", () => {
    const uuids: string[] = [];
    for (let i = 0; i < 50; i++) {
      uuids.push(generateUUIDv7());
    }
    const sorted = [...uuids].sort();
    // Due to same-millisecond randomness, not strictly sorted,
    // but the first 12 hex chars (timestamp) should be non-decreasing
    for (let i = 1; i < uuids.length; i++) {
      const prevTs = uuids[i - 1].replace(/-/g, "").slice(0, 12);
      const currTs = uuids[i].replace(/-/g, "").slice(0, 12);
      expect(currTs >= prevTs).toBe(true);
    }
  });

  test("extractTimestampFromUUIDv7 returns correct timestamp", () => {
    const before = Date.now();
    const uuid = generateUUIDv7();
    const after = Date.now();
    const extracted = extractTimestampFromUUIDv7(uuid);
    expect(extracted).toBeGreaterThanOrEqual(before);
    expect(extracted).toBeLessThanOrEqual(after);
  });

  test("extractTimestampFromUUIDv7 with invalid input returns NaN", () => {
    expect(extractTimestampFromUUIDv7("not-a-uuid")).toBeNaN();
    expect(extractTimestampFromUUIDv7("")).toBeNaN();
  });

  test("UUIDv7 timestamp encodes current time correctly", () => {
    const now = Date.now();
    const uuid = generateUUIDv7();
    const ts = extractTimestampFromUUIDv7(uuid);
    // Should be within 100ms of now
    expect(Math.abs(ts - now)).toBeLessThan(100);
  });

  test("UUIDv7 has correct string length (36 chars with hyphens)", () => {
    const uuid = generateUUIDv7();
    expect(uuid.length).toBe(36);
  });

  test("UUIDv7 generated at different times are time-ordered", async () => {
    const uuid1 = generateUUIDv7();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const uuid2 = generateUUIDv7();

    const ts1 = extractTimestampFromUUIDv7(uuid1);
    const ts2 = extractTimestampFromUUIDv7(uuid2);
    expect(ts2).toBeGreaterThan(ts1);
    // Lexicographic comparison should also hold
    expect(uuid2 > uuid1).toBe(true);
  });
});
