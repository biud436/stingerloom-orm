/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The statements `SchemaDiffMigrationGenerator` writes for new tables: the
 * table, its indexes, its foreign keys and its join tables, named by the
 * naming strategy the generator is given, and reverted in dependency order.
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  Index,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  UniqueIndex,
} from "../../src";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { DefaultNamingStrategy } from "../../src/core/generators/NamingStrategy";
import { createSchemaDiffResult } from "../../src/core/generators/SchemaDiff";

@Entity({ name: "gnt_team" })
class Team {
  @PrimaryGeneratedColumn() id!: number;
}

@Entity({ name: "gnt_skill" })
class Skill {
  @PrimaryGeneratedColumn() id!: number;
}

@Entity({ name: "gnt_member" })
@UniqueIndex(["email"])
class Member {
  @PrimaryGeneratedColumn() id!: number;
  @Index() @Column({ type: "varchar", length: 80 }) email!: string;

  @ManyToOne(() => Team, undefined as any, {
    joinColumn: "team_id",
    onDelete: "SET NULL",
  })
  team!: Team;

  @ManyToMany(() => Skill, {
    joinTable: {
      name: "gnt_member_skills",
      joinColumn: "member_id",
      inverseJoinColumn: "skill_id",
    },
  } as any)
  skills!: Skill[];
}

class PrefixedNaming extends DefaultNamingStrategy {
  foreignKeyName(table: string, column: string): string {
    return `FK_${table}_${column}`;
  }
  indexName(table: string, column: string): string {
    return `IX_${table}_${column}`;
  }
  uniqueIndexName(table: string, columns: string[]): string {
    return `UQ_${table}_${columns.join("_")}`;
  }
}

const diff = () =>
  createSchemaDiffResult({
    addTables: ["gnt_member", "gnt_team", "gnt_skill"],
    addTableEntityMap: {
      gnt_member: Member,
      gnt_team: Team,
      gnt_skill: Skill,
    },
    addJoinTables: [{ tableName: "gnt_member_skills", ownerEntity: Member }],
  });

describe("SchemaDiffMigrationGenerator: new tables", () => {
  it("writes indexes, foreign keys and join tables after the tables on MySQL", () => {
    const { up, down } = new SchemaDiffMigrationGenerator(
      undefined,
      undefined,
      new PrefixedNaming(),
    ).dryRun(diff(), "mysql");

    expect(up).toEqual([
      "CREATE TABLE IF NOT EXISTS `gnt_team` (`id` INT(11) NOT NULL PRIMARY KEY AUTO_INCREMENT) ENGINE=InnoDB",
      "CREATE TABLE IF NOT EXISTS `gnt_skill` (`id` INT(11) NOT NULL PRIMARY KEY AUTO_INCREMENT) ENGINE=InnoDB",
      "CREATE TABLE IF NOT EXISTS `gnt_member` (`id` INT(11) NOT NULL PRIMARY KEY AUTO_INCREMENT, `email` VARCHAR(80) NOT NULL, `team_id` INT(11) NULL) ENGINE=InnoDB",
      "CREATE INDEX `IX_gnt_member_email` ON `gnt_member` (`email`)",
      "CREATE UNIQUE INDEX `UQ_gnt_member_email` ON `gnt_member` (`email`)",
      "ALTER TABLE `gnt_member` ADD CONSTRAINT `FK_gnt_member_team_id` FOREIGN KEY (`team_id`) REFERENCES `gnt_team`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION",
      "CREATE TABLE IF NOT EXISTS `gnt_member_skills` (`member_id` INT NOT NULL, `skill_id` INT NOT NULL, PRIMARY KEY (`member_id`, `skill_id`)) ENGINE=InnoDB",
      "ALTER TABLE `gnt_member_skills` ADD CONSTRAINT FK_gnt_member_skills_member_id FOREIGN KEY (`member_id`) REFERENCES `gnt_member`(`id`) ON DELETE CASCADE ON UPDATE CASCADE",
      "ALTER TABLE `gnt_member_skills` ADD CONSTRAINT FK_gnt_member_skills_skill_id FOREIGN KEY (`skill_id`) REFERENCES `gnt_skill`(`id`) ON DELETE CASCADE ON UPDATE CASCADE",
    ]);
    expect(down).toEqual([
      "DROP TABLE IF EXISTS `gnt_member_skills`",
      "ALTER TABLE `gnt_member` DROP FOREIGN KEY `FK_gnt_member_team_id`",
      "DROP TABLE IF EXISTS `gnt_member`",
      "DROP TABLE IF EXISTS `gnt_skill`",
      "DROP TABLE IF EXISTS `gnt_team`",
    ]);
  });

  it("declares the foreign keys inside CREATE TABLE on SQLite", () => {
    const { up, down } = new SchemaDiffMigrationGenerator().dryRun(
      diff(),
      "sqlite",
    );

    expect(up.filter((statement) => statement.startsWith("ALTER"))).toEqual([]);
    expect(up[2]).toContain(
      'FOREIGN KEY ("team_id") REFERENCES "gnt_team" ("id") ON DELETE SET NULL',
    );
    expect(up[up.length - 1]).toMatch(
      /^CREATE TABLE IF NOT EXISTS "gnt_member_skills" .*FOREIGN KEY \("member_id"\) REFERENCES "gnt_member"\("id"\).*FOREIGN KEY \("skill_id"\) REFERENCES "gnt_skill"\("id"\)/,
    );
    expect(down).toEqual([
      'DROP TABLE IF EXISTS "gnt_member_skills"',
      'DROP TABLE IF EXISTS "gnt_member"',
      'DROP TABLE IF EXISTS "gnt_skill"',
      'DROP TABLE IF EXISTS "gnt_team"',
    ]);
  });

  it("creates only a join table when nothing else is new", () => {
    const { up, down } = new SchemaDiffMigrationGenerator().dryRun(
      createSchemaDiffResult({
        addJoinTables: [{ tableName: "gnt_member_skills", ownerEntity: Member }],
      }),
      "postgres",
    );

    expect(up).toHaveLength(3);
    expect(up[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "public"."gnt_member_skills"/);
    expect(down).toEqual(['DROP TABLE IF EXISTS "public"."gnt_member_skills"']);
  });
});
