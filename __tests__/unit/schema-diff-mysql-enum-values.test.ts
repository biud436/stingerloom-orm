/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MySQL / MariaDB keep an ENUM's values in the column type itself
 * (`enum('draft','published')`), so the diff has to read `COLUMN_TYPE` to see
 * a changed value list — `DATA_TYPE` is just `enum`. And MODIFY COLUMN, which
 * applies the change, replaces the whole column definition: the declared
 * default has to be restated or the column loses it.
 */
import "reflect-metadata";
import {
  SchemaDiff,
  parseMySqlEnumValues,
} from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { SchemaRegistrar } from "../../src/core/SchemaRegistrar";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityManagerInternals } from "../../src/core/EntityManagerInternals";
import { SynchronizePolicy } from "../../src/core/DatabaseClientOptions";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Logger } from "../../src/utils/Logger";

function postEntity(values: string[]) {
  @Entity({ name: "mev_post" })
  class MevPost {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "enum", enumValues: values, default: "draft" }) status!: string;
  }
  return MevPost;
}

/** A query runner whose information_schema holds `status` as `columnType`. */
function runnerWith(columnType: string, dataType = "enum") {
  return {
    query: jest.fn(async (input: any) => {
      const values: unknown[] = input?.values ?? [];
      if (!values.includes("mev_post")) return [];
      return [
        { column_name: "id", data_type: "int", is_nullable: "NO", column_type: "int(11)" },
        {
          column_name: "status",
          data_type: dataType,
          is_nullable: "NO",
          character_maximum_length: 9,
          column_type: columnType,
        },
      ];
    }),
  };
}

describe("parseMySqlEnumValues", () => {
  it("reads the values in order", () => {
    expect(parseMySqlEnumValues("enum('draft','published')")).toEqual([
      "draft",
      "published",
    ]);
  });

  it("reads quotes, backslashes, commas and empty values the way the server spells them", () => {
    // MariaDB 11.8 reports ENUM('a','it''s','back\\slash','x,y','') like this.
    expect(
      parseMySqlEnumValues("enum('a','it''s','back\\\\slash','x,y','')"),
    ).toEqual(["a", "it's", "back\\slash", "x,y", ""]);
  });

  it("reads escaped control characters", () => {
    expect(parseMySqlEnumValues("enum('line\\nbreak','nul\\0')")).toEqual([
      "line\nbreak",
      "nul\0",
    ]);
  });

  it("returns undefined for a column that is not an ENUM", () => {
    expect(parseMySqlEnumValues("varchar(20)")).toBeUndefined();
    expect(parseMySqlEnumValues("set('a','b')")).toBeUndefined();
    expect(parseMySqlEnumValues(undefined)).toBeUndefined();
  });
});

describe("SchemaDiff: MySQL ENUM value lists", () => {
  it("reports an added value as an ALTER that carries the current values and the default", async () => {
    const result = await new SchemaDiff().diff(
      [postEntity(["draft", "published", "archived"])],
      runnerWith("enum('draft','published')"),
      "mysql",
    );

    expect(result.alterColumns).toHaveLength(1);
    expect(result.alterColumns[0]).toMatchObject({
      columnName: "status",
      columnType: "ENUM('draft','published','archived')",
      currentType: "enum",
      currentColumnType: "enum('draft','published')",
      currentEnumValues: ["draft", "published"],
      defaultValue: "draft",
    });
  });

  it("reports nothing when the values match", async () => {
    const result = await new SchemaDiff().diff(
      [postEntity(["draft", "published"])],
      runnerWith("enum('draft','published')"),
      "mysql",
    );
    expect(result.alterColumns).toEqual([]);
  });

  it("reports a reordered list: the order is the one ORDER BY sorts by", async () => {
    const result = await new SchemaDiff().diff(
      [postEntity(["published", "draft"])],
      runnerWith("enum('draft','published')"),
      "mysql",
    );
    expect(result.alterColumns).toHaveLength(1);
  });

  it("compares a value with trailing spaces as the server stores it", async () => {
    // CREATE TABLE stores 'draft ' as 'draft'; comparing the raw value would
    // alter the column on every boot.
    const result = await new SchemaDiff().diff(
      [postEntity(["draft ", "published"])],
      runnerWith("enum('draft','published')"),
      "mysql",
    );
    expect(result.alterColumns).toEqual([]);
  });

  it("leaves a PostgreSQL enum column to the named-type comparison", async () => {
    const runner = {
      query: jest.fn(async (input: any) => {
        const text: string = typeof input === "string" ? input : (input?.text ?? input?.sql ?? "");
        const values: unknown[] = input?.values ?? [];
        if (text.includes("pg_enum")) {
          return { rows: [{ enumlabel: "draft" }, { enumlabel: "published" }] };
        }
        if (!values.includes("mev_post")) return { rows: [] };
        return {
          rows: [
            { column_name: "id", data_type: "integer", is_nullable: "NO" },
            { column_name: "status", data_type: "USER-DEFINED", is_nullable: "NO" },
          ],
        };
      }),
    };
    const result = await new SchemaDiff().diff(
      [postEntity(["draft", "published", "archived"])],
      runner,
      "postgres",
    );
    expect(result.alterColumns).toEqual([]);
    expect(result.enumChanges).toEqual([
      expect.objectContaining({ addValues: ["archived"], isNew: false }),
    ]);
  });
});

describe("migrate:generate: MySQL MODIFY COLUMN", () => {
  it("restates the default in up() and restores the previous ENUM in down()", async () => {
    const diff = await new SchemaDiff().diff(
      [postEntity(["draft", "published", "archived"])],
      runnerWith("enum('draft','published')"),
      "mysql",
    );
    const { up, down } = new SchemaDiffMigrationGenerator().dryRun(diff, "mysql");

    expect(up).toContain(
      "ALTER TABLE `mev_post` MODIFY COLUMN `status` ENUM('draft','published','archived') NOT NULL DEFAULT 'draft'",
    );
    expect(down).toContain(
      "ALTER TABLE `mev_post` MODIFY COLUMN `status` enum('draft','published') NOT NULL DEFAULT 'draft'",
    );
  });

  it("restores a widened VARCHAR to its full previous type, not the bare name", async () => {
    @Entity({ name: "mev_note" })
    class MevNote {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "varchar", length: 40, default: "x" }) note!: string;
    }
    const runner = {
      query: jest.fn(async (input: any) => {
        const values: unknown[] = input?.values ?? [];
        if (!values.includes("mev_note")) return [];
        return [
          { column_name: "id", data_type: "int", is_nullable: "NO", column_type: "int(11)" },
          {
            column_name: "note",
            data_type: "varchar",
            is_nullable: "NO",
            character_maximum_length: 20,
            column_type: "varchar(20)",
          },
        ];
      }),
    };
    const diff = await new SchemaDiff().diff([MevNote], runner, "mysql");
    const { up, down } = new SchemaDiffMigrationGenerator().dryRun(diff, "mysql");

    expect(up).toContain(
      "ALTER TABLE `mev_note` MODIFY COLUMN `note` VARCHAR(40) NOT NULL DEFAULT 'x'",
    );
    expect(down).toContain(
      "ALTER TABLE `mev_note` MODIFY COLUMN `note` varchar(20) NOT NULL DEFAULT 'x'",
    );
  });
});

describe("synchronize: MySQL ENUM value changes", () => {
  const policy = (failOnDestructiveChange: boolean): SynchronizePolicy => ({
    mode: true,
    continueOnError: true,
    failOnDestructiveChange,
    logDDL: false,
  });

  async function sync(values: string[], current: string, p: SynchronizePolicy) {
    const executed: string[] = [];
    const driver: any = {
      executeRaw: jest.fn(async (ddl: string) => {
        executed.push(ddl);
      }),
    };
    const ctx = {
      wrap: (c: string) => `\`${c}\``,
      wrapTable: (t: string) => `\`${t}\``,
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
      getDriver: () => driver,
      getSynchronize: () => p.mode,
      getSynchronizePolicy: () => p,
      getDialect: () => "mysql",
      getSchema: () => undefined,
      getConnection: () => undefined,
      getEntities: () => [],
    } as unknown as EntityManagerInternals;
    const registrar = new SchemaRegistrar({} as RelationMetadataResolver, ctx);
    (registrar as any).activePolicy = p;
    const diff = await new SchemaDiff().diff(
      [postEntity(values)],
      runnerWith(current),
      "mysql",
    );
    await (registrar as any).applySchemaDiff(diff, new Map(), p, "mysql");
    return executed;
  }

  beforeEach(() => {
    Logger.setOutput(() => undefined);
  });

  afterEach(() => {
    Logger.reset();
  });

  it("applies an added value and keeps the default", async () => {
    const executed = await sync(
      ["draft", "published", "archived"],
      "enum('draft','published')",
      policy(true),
    );
    expect(executed).toEqual([
      "ALTER TABLE `mev_post` MODIFY COLUMN `status` ENUM('draft','published','archived') NOT NULL DEFAULT 'draft'",
    ]);
  });

  it("treats a removed value as narrowing under failOnDestructiveChange", async () => {
    await expect(
      sync(["draft"], "enum('draft','published')", policy(true)),
    ).rejects.toMatchObject({
      code: OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE,
      message: expect.stringContaining(
        "enum('draft','published') → ENUM('draft')",
      ),
    });
  });

  it("applies a removed value when destructive changes are allowed", async () => {
    const executed = await sync(["draft"], "enum('draft','published')", policy(false));
    expect(executed).toEqual([
      "ALTER TABLE `mev_post` MODIFY COLUMN `status` ENUM('draft') NOT NULL DEFAULT 'draft'",
    ]);
  });
});
