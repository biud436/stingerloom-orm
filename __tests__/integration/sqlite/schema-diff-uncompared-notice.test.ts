/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `synchronize` and `migrate:generate` say what they do not compare on an
 * existing table.
 *
 * Both diff an existing table column by column: a changed `default`, a
 * changed `onDelete`, an `@Index` removed from the entity or a rewritten
 * `@ComputedColumn` expression is left in the database as it was, and
 * nothing in the logs said so — a restart after such an edit looked like a
 * successful sync, and `migrate:generate` printed "No schema changes
 * detected". `migrate:generate` also never adds an index or a foreign key
 * constraint to an existing table, although `synchronize` does.
 *
 * Measured on SQLite, PostgreSQL and MariaDB before this notice was added;
 * the table in docs/migrations.md records the results.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Column,
  ComputedColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
} from "../../../src";
import { MigrationCli } from "../../../src/migration/MigrationCli";
import { Logger } from "../../../src/utils/Logger";
import type { SynchronizeOption } from "../../../src/core/DatabaseClientOptions";
import { createTestConnection, resetMetadata } from "../helpers/test-connection";

const SYNC_NOTICE = "synchronize does not apply these to existing tables";
const GENERATE_NOTICE = "migrate:generate does not write these for existing tables";

/** Owner ← Item with a default, an onDelete, an index and a computed column. */
function fullEntities(): any[] {
  @Entity({ name: "unc_owner" })
  class Owner {
    @PrimaryGeneratedColumn() id!: number;
  }

  @Entity({ name: "unc_item" })
  class Item {
    @PrimaryGeneratedColumn() id!: number;
    @Index() @Column({ type: "varchar", length: 20 }) code!: string;
    @Column({ type: "int", default: 1 }) qty!: number;
    @ComputedColumn({ expression: "qty * 2", type: "int" }) double!: number;
    @ManyToOne(() => Owner, () => undefined, { onDelete: "CASCADE" })
    @RelationColumn({ name: "owner_id" })
    owner!: Owner;
  }

  return [Owner, Item];
}

/** A table declaring none of the uncompared properties. */
function plainEntities(): any[] {
  @Entity({ name: "unc_plain" })
  class Plain {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 20 }) name!: string;
  }
  return [Plain];
}

describe("[Integration] SQLite: the schema diff says what it does not compare", () => {
  let dir: string;
  let options: any;
  let lines: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stg-unc-"));
    options = { type: "sqlite", database: path.join(dir, "db.sqlite") };
    lines = [];
    Logger.setOutput((message) => lines.push(message));
  });

  afterEach(() => {
    Logger.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function boot(
    entities: () => any[],
    synchronize: SynchronizeOption = true,
  ): Promise<void> {
    const conn = await createTestConnection(
      { ...options, synchronize, logging: false },
      () => ({ entities: entities() }),
    );
    await conn.cleanup();
  }

  async function generate(entities: () => any[]): Promise<void> {
    resetMetadata();
    const cli = new MigrationCli([], {
      ...options,
      entities: entities(),
      synchronize: false,
      logging: false,
    });
    await cli.connect();
    cli.setGenerateOptions({ outputDir: path.join(dir, "migrations") });
    try {
      await cli.execute("migrate:generate");
    } finally {
      await cli.close();
    }
  }

  const notices = (prefix: string) => lines.filter((l) => l.includes(prefix));

  describe("synchronize", () => {
    it("says nothing on the boot that creates every table", async () => {
      await boot(fullEntities);

      expect(notices(SYNC_NOTICE)).toEqual([]);
    });

    it("lists the kinds the entities declare, once, when a table already existed", async () => {
      await boot(fullEntities);
      lines.length = 0;

      await boot(fullEntities);

      const [notice, ...rest] = notices(SYNC_NOTICE);
      expect(rest).toEqual([]);
      expect(notice).toContain(
        `${SYNC_NOTICE}: changed column defaults, changed foreign key onDelete/onUpdate, ` +
          `removed or redefined indexes, changed computed column expressions, ` +
          `foreign key constraints for relations added to an existing table. ` +
          `Write a migration for them (see docs/migrations.md#what-the-schema-diff-does-not-compare).`,
      );
    });

    it("lists only index changes for a table that declares nothing else", async () => {
      await boot(plainEntities);
      lines.length = 0;

      await boot(plainEntities);

      expect(notices(SYNC_NOTICE)).toEqual([
        expect.stringContaining(`${SYNC_NOTICE}: removed or redefined indexes.`),
      ]);
    });

    it("is logged in safe and dry-run modes too", async () => {
      await boot(plainEntities);
      lines.length = 0;

      await boot(plainEntities, "safe");
      await boot(plainEntities, "dry-run");

      expect(notices(SYNC_NOTICE)).toHaveLength(2);
    });

    it("is not logged when synchronize is off", async () => {
      await boot(plainEntities);
      lines.length = 0;

      await boot(plainEntities, false);

      expect(notices(SYNC_NOTICE)).toEqual([]);
    });
  });

  describe("migrate:generate", () => {
    it("adds that it writes no index or foreign key constraint for an existing table", async () => {
      await boot(fullEntities);
      lines.length = 0;

      await generate(fullEntities);

      expect(lines.some((l) => l.includes("No schema changes detected"))).toBe(
        true,
      );
      expect(notices(GENERATE_NOTICE)).toEqual([
        expect.stringContaining(
          `${GENERATE_NOTICE}: new indexes and foreign key constraints, changed column defaults, ` +
            `changed foreign key onDelete/onUpdate, removed or redefined indexes, ` +
            `changed computed column expressions. Add them to the migration by hand`,
        ),
      ]);
    });

    it("is logged after a generated migration as well", async () => {
      await boot(plainEntities);
      lines.length = 0;

      await generate(() => {
        @Entity({ name: "unc_plain" })
        class Plain {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 20 }) name!: string;
          @Column({ type: "int", nullable: true }) rank!: number | null;
        }
        return [Plain];
      });

      expect(lines.some((l) => l.includes("Migration generated"))).toBe(true);
      expect(notices(GENERATE_NOTICE)).toHaveLength(1);
    });

    it("says nothing when every table is new", async () => {
      await generate(fullEntities);

      expect(notices(GENERATE_NOTICE)).toEqual([]);
    });
  });
});
