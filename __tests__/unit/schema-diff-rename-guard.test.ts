/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import {
  columnNameSimilarity,
  columnNamesLookRenamed,
  normalizeColumnName,
} from "../../src/core/generators/columnRenameMatch";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

/**
 * A rename and a column swap produce the same add/drop pair, and guessing
 * wrong moves the dropped column's rows under the new name. The diff now only
 * renames on an explicit `renamedFrom` or on names that read as the same
 * column; everything else is reported as a candidate and applied as the
 * declared drop + add.
 */
describe("SchemaDiff — column rename inference guard", () => {
  function runnerFor(columns: any[]): { query: jest.Mock } {
    return { query: jest.fn(async () => columns) };
  }

  const idRow = { column_name: "id", data_type: "int", is_nullable: "NO" };
  const varchar = (name: string, length = 100) => ({
    column_name: name,
    data_type: "varchar",
    is_nullable: "YES",
    character_maximum_length: length,
  });

  describe("names that do not read as the same column", () => {
    @Entity({ name: "rg_profile" })
    class RgProfile {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "varchar", length: 100, nullable: true })
      bio!: string;
    }

    it("does not rename legacyNote → bio; it reports the pair and keeps the drop + add", async () => {
      const result = await new SchemaDiff().diff(
        [RgProfile],
        runnerFor([idRow, varchar("legacyNote")]),
        "mysql",
      );

      expect(result.renamedColumns).toHaveLength(0);
      expect(result.addColumns.map((c) => c.columnName)).toEqual(["bio"]);
      expect(result.dropColumns.map((c) => c.columnName)).toEqual([
        "legacyNote",
      ]);

      expect(result.renameCandidates).toHaveLength(1);
      expect(result.renameCandidates![0]).toMatchObject({
        tableName: "rg_profile",
        newColumnName: "bio",
        candidateColumns: ["legacyNote"],
        reason: "dissimilar-names",
      });
    });

    it("renames when the entity declares renamedFrom", async () => {
      @Entity({ name: "rg_profile_hint" })
      class RgProfileHint {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({
          type: "varchar",
          length: 100,
          nullable: true,
          renamedFrom: "legacyNote",
        })
        bio!: string;
      }

      const result = await new SchemaDiff().diff(
        [RgProfileHint],
        runnerFor([idRow, varchar("legacyNote")]),
        "mysql",
      );

      expect(result.renameCandidates).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
      expect(result.renamedColumns).toEqual([
        {
          tableName: "rg_profile_hint",
          oldColumnName: "legacyNote",
          newColumnName: "bio",
          columnType: "VARCHAR(100)",
          reason: "hint",
        },
      ]);
    });

    it("ignores a renamedFrom hint whose column is not being dropped", async () => {
      @Entity({ name: "rg_inert_hint" })
      class RgInertHint {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({
          type: "varchar",
          length: 100,
          nullable: true,
          renamedFrom: "gone_long_ago",
        })
        bio!: string;
      }

      const result = await new SchemaDiff().diff(
        [RgInertHint],
        runnerFor([idRow]),
        "mysql",
      );

      expect(result.renamedColumns).toHaveLength(0);
      expect(result.addColumns.map((c) => c.columnName)).toEqual(["bio"]);
    });
  });

  describe("names that do read as the same column", () => {
    it("renames a separator/case change", async () => {
      @Entity({ name: "rg_user" })
      class RgUser {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100, nullable: true })
        userName!: string;
      }

      const result = await new SchemaDiff().diff(
        [RgUser],
        runnerFor([idRow, varchar("user_name")]),
        "mysql",
      );

      expect(result.renamedColumns).toHaveLength(1);
      expect(result.renamedColumns![0]).toMatchObject({
        oldColumnName: "user_name",
        newColumnName: "userName",
        reason: "similar-name",
      });
      expect(result.renameCandidates).toHaveLength(0);
    });

    it("renames a qualifier that grew onto the name", async () => {
      @Entity({ name: "rg_person" })
      class RgPerson {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100, nullable: true })
        full_name!: string;
      }

      const result = await new SchemaDiff().diff(
        [RgPerson],
        runnerFor([idRow, varchar("name")]),
        "mysql",
      );

      expect(result.renamedColumns).toHaveLength(1);
      expect(result.renamedColumns![0].oldColumnName).toBe("name");
    });
  });

  describe("ambiguous pairs", () => {
    it("refuses when two dropped columns are equally plausible", async () => {
      @Entity({ name: "rg_ticket" })
      class RgTicket {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100, nullable: true })
        note!: string;
      }

      const result = await new SchemaDiff().diff(
        [RgTicket],
        runnerFor([idRow, varchar("note_a"), varchar("note_b")]),
        "mysql",
      );

      expect(result.renamedColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(2);
      expect(result.addColumns).toHaveLength(1);
      expect(result.renameCandidates![0].reason).toBe("ambiguous");
      expect(result.renameCandidates![0].candidateColumns.sort()).toEqual([
        "note_a",
        "note_b",
      ]);
    });

    it("refuses a 2 drop + 2 add shuffle of unrelated names", async () => {
      @Entity({ name: "rg_shuffle" })
      class RgShuffle {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100, nullable: true })
        alpha!: string;

        @Column({ type: "varchar", length: 100, nullable: true })
        beta!: string;
      }

      const result = await new SchemaDiff().diff(
        [RgShuffle],
        runnerFor([idRow, varchar("gamma"), varchar("delta")]),
        "mysql",
      );

      expect(result.renamedColumns).toHaveLength(0);
      expect(result.addColumns).toHaveLength(2);
      expect(result.dropColumns).toHaveLength(2);
      expect(result.renameCandidates).toHaveLength(2);
    });

    it("still renames every column of a naming-strategy switch", async () => {
      @Entity({ name: "rg_snake" })
      class RgSnake {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100, nullable: true })
        first_name!: string;

        @Column({ type: "varchar", length: 100, nullable: true })
        last_name!: string;

        @Column({ type: "varchar", length: 100, nullable: true })
        home_town!: string;
      }

      const result = await new SchemaDiff().diff(
        [RgSnake],
        runnerFor([
          idRow,
          varchar("firstName"),
          varchar("lastName"),
          varchar("homeTown"),
        ]),
        "mysql",
      );

      expect(result.renamedColumns).toHaveLength(3);
      expect(result.addColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
      expect(result.renameCandidates).toHaveLength(0);
    });
  });

  describe("migrate:generate output", () => {
    it("offers a refused rename as a commented-out alternative", () => {
      const generator = new SchemaDiffMigrationGenerator();
      const content = generator.generate(
        {
          addTables: [],
          dropTables: [],
          addColumns: [
            {
              tableName: "rg_profile",
              columnName: "bio",
              columnType: "VARCHAR(100)",
              nullable: true,
            },
          ],
          dropColumns: [
            { tableName: "rg_profile", columnName: "legacyNote" },
          ],
          alterColumns: [],
          renamedColumns: [],
          renameCandidates: [
            {
              tableName: "rg_profile",
              newColumnName: "bio",
              candidateColumns: ["legacyNote"],
              columnType: "VARCHAR(100)",
              reason: "dissimilar-names",
            },
          ],
        },
        "postgres",
      );

      expect(content).toContain("ADD COLUMN");
      expect(content).toContain("// POSSIBLE RENAME");
      expect(content).toMatch(
        /\/\/ await query\(`ALTER TABLE "rg_profile" RENAME COLUMN "legacyNote" TO "bio"`\)/,
      );
    });
  });

  describe("name matcher", () => {
    it("normalizes case and separators", () => {
      expect(normalizeColumnName("User_Name")).toBe("username");
      expect(normalizeColumnName("user-name")).toBe("username");
    });

    it.each([
      ["userName", "user_name"],
      ["name", "full_name"],
      ["legacyNote", "note"],
      ["recieved_at", "received_at"],
    ])("reads %s / %s as the same column", (a, b) => {
      expect(columnNamesLookRenamed(a, b)).toBe(true);
    });

    it.each([
      ["bio", "legacyNote"],
      ["createdAt", "updatedAt"],
      ["alpha", "gamma"],
      ["id", "uuid"],
    ])("reads %s / %s as different columns", (a, b) => {
      expect(columnNamesLookRenamed(a, b)).toBe(false);
    });

    it("scores identical normalized names as 1", () => {
      expect(columnNameSimilarity("userName", "USER_NAME")).toBe(1);
      expect(columnNameSimilarity("bio", "legacyNote")).toBeLessThan(0.3);
    });
  });
});
