/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SchemaDiff × @ComputedColumn (V5-T0-3)
 *
 * Before the fix the diff was blind to computed-column metadata:
 *  - a generated column present in the DB (created by a migration or by the
 *    new runtime sync) was classified as a DROP candidate — synchronize: true
 *    dropped it on the next boot (MySQL/PostgreSQL, where information_schema
 *    reports generated columns);
 *  - a computed column missing from the DB was never added.
 */
import "reflect-metadata";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { createSchemaDiffResult } from "../../src/core/generators/SchemaDiff";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ComputedColumn } from "../../src/decorators/ComputedColumn";

@Entity()
class ComputedDiffLine {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  qty!: number;

  @ComputedColumn({ expression: "qty * 10", type: "int" })
  scaled!: number;
}

const baseDbColumns = [
  { column_name: "id", data_type: "INT", is_nullable: "NO" },
  { column_name: "qty", data_type: "INT", is_nullable: "NO" },
];

function runnerWith(columns: any[]): { query: jest.Mock } {
  return {
    query: jest.fn(() => Promise.resolve(columns)),
  };
}

describe("SchemaDiff × @ComputedColumn", () => {
  it("emits addComputedColumns when the generated column is missing from the DB", async () => {
    const runner = runnerWith(baseDbColumns);
    const diff = await new SchemaDiff().diff(
      [ComputedDiffLine],
      runner,
      "mysql",
    );
    expect(diff.addComputedColumns).toHaveLength(1);
    expect(diff.addComputedColumns![0]).toMatchObject({
      tableName: "computed_diff_line",
      column: { name: "scaled" },
    });
    // and never through the plain addColumns path (its DDL lacks GENERATED)
    expect(diff.addColumns).toHaveLength(0);
  });

  it("never marks an existing generated column as a drop candidate", async () => {
    const runner = runnerWith([
      ...baseDbColumns,
      { column_name: "scaled", data_type: "INT", is_nullable: "YES" },
    ]);
    const diff = await new SchemaDiff().diff(
      [ComputedDiffLine],
      runner,
      "mysql",
    );
    expect(diff.dropColumns).toHaveLength(0);
    expect(diff.addComputedColumns).toHaveLength(0);
    // an existing generated column is never type-compared either
    expect(diff.alterColumns).toHaveLength(0);
  });

  it("generates ADD COLUMN ... GENERATED ALWAYS AS in migration up SQL and DROP COLUMN in down SQL", async () => {
    const diff = createSchemaDiffResult({
      addComputedColumns: [
        {
          tableName: "computed_diff_line",
          column: {
            propertyKey: "scaled",
            name: "scaled",
            options: { expression: "qty * 10", type: "int" },
          },
        },
      ],
    });
    const generator = new SchemaDiffMigrationGenerator();
    const { up, down } = await generator.dryRun(diff, "mysql");
    expect(up).toContainEqual(
      expect.stringContaining(
        "ADD COLUMN `scaled` INT GENERATED ALWAYS AS (qty * 10) VIRTUAL",
      ),
    );
    expect(down).toContainEqual(
      expect.stringContaining("DROP COLUMN `scaled`"),
    );
  });
});
