/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `migrate:generate` checks the relation graph the way a synchronize boot
 * does, before it reads the database.
 *
 * A foreign key column holds one value. Against a composite primary key the
 * generated migration declared a constraint on the first key column only:
 * PostgreSQL refuses that constraint at migrate:run, and SQLite accepts the
 * table and then rejects every write to either table with "foreign key
 * mismatch". register() refuses that graph when synchronize builds the
 * schema; the migration builds the same schema, so it is refused the same
 * way, and no file is written.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Column,
  Entity,
  ManyToMany,
  ManyToOne,
  OrmErrorCode,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import { MigrationCli } from "../../../src/migration/MigrationCli";
import { createTestConnection, resetMetadata } from "../helpers/test-connection";

describe("[Integration] SQLite: migrate:generate validates the relation graph", () => {
  let dir: string;
  let outputDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stg-mgrg-"));
    outputDir = path.join(dir, "migrations");
  });

  afterEach(() => {
    resetMetadata();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const database = () => ({
    type: "sqlite" as const,
    database: path.join(dir, "app.sqlite"),
  });

  async function generate(entities: () => any[]): Promise<{ up: string[] }> {
    resetMetadata();
    const cli = new MigrationCli([], {
      ...database(),
      entities: entities(),
      synchronize: false,
      logging: false,
    } as any);
    await cli.connect();
    cli.setGenerateOptions({ outputDir });
    try {
      const result = (await cli.execute("migrate:generate")) as any;
      return result.sql;
    } finally {
      await cli.close();
    }
  }

  async function rejectionOf(work: () => Promise<unknown>): Promise<any> {
    try {
      await work();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  const writtenFiles = () =>
    fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];

  async function onDatabase(
    work: (query: (statement: string) => Promise<any[]>) => Promise<void>,
  ): Promise<void> {
    resetMetadata();
    const conn = await createTestConnection(
      { ...database(), synchronize: false, logging: false },
      () => ({ entities: [] }),
    );
    try {
      await work(
        async (statement) => (await conn.em.query(statement)) as unknown as any[],
      );
    } finally {
      await conn.cleanup();
    }
  }

  const orders = () => {
    @Entity({ name: "mgrg_orders" })
    @UniqueIndex(["code"])
    class Order {
      @PrimaryColumn({ type: "int" }) tenantId!: number;
      @PrimaryColumn({ type: "int" }) orderNo!: number;
      @Column({ type: "varchar", length: 40 }) code!: string;
    }
    return Order;
  };

  it("refuses a ManyToOne whose foreign key would reference part of a composite key", async () => {
    const error = await rejectionOf(() =>
      generate(() => {
        const Order = orders();
        @Entity({ name: "mgrg_lines" })
        class Line {
          @PrimaryGeneratedColumn() id!: number;
          @ManyToOne(() => Order, undefined as any)
          @RelationColumn({ name: "order_id" })
          order!: InstanceType<typeof Order>;
        }
        return [Order, Line];
      }),
    );

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error?.message).toContain(
      "Line.order: @ManyToOne needs a single-column key on Order, which has the composite primary key (tenantId, orderNo)",
    );
    expect(error?.message).toContain("referencedColumn");
    expect(writtenFiles()).toEqual([]);
  });

  it("refuses a ManyToMany whose target has a composite key", async () => {
    const error = await rejectionOf(() =>
      generate(() => {
        const Order = orders();
        @Entity({ name: "mgrg_tags" })
        class Tag {
          @PrimaryGeneratedColumn() id!: number;
          @ManyToMany(() => Order, {
            joinTable: {
              name: "mgrg_tag_orders",
              joinColumn: "tag_id",
              inverseJoinColumn: "order_id",
            },
          } as any)
          orders!: InstanceType<typeof Order>[];
        }
        return [Order, Tag];
      }),
    );

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error?.message).toContain(
      "Tag.orders: @ManyToMany needs a single-column key on Order, which has the composite primary key (tenantId, orderNo)",
    );
    expect(writtenFiles()).toEqual([]);
  });

  it("generates a working migration when the relation names the column it references", async () => {
    const { up } = await generate(() => {
      const Order = orders();
      @Entity({ name: "mgrg_lines" })
      class Line {
        @PrimaryGeneratedColumn() id!: number;
        @ManyToOne(() => Order, undefined as any)
        @RelationColumn({ name: "order_code", referencedColumn: "code", type: "varchar" } as any)
        order!: InstanceType<typeof Order>;
      }
      return [Order, Line];
    });
    expect(writtenFiles()).toHaveLength(1);

    await onDatabase(async (query) => {
      for (const statement of up) await query(statement);

      const foreignKeys = await query(`PRAGMA foreign_key_list("mgrg_lines")`);
      expect(foreignKeys.map((fk) => `${fk.from} -> ${fk.table}.${fk.to}`)).toEqual([
        "order_code -> mgrg_orders.code",
      ]);
      // A constraint on part of the key would fail both writes with
      // "foreign key mismatch".
      await query(`INSERT INTO "mgrg_orders" ("tenantId", "orderNo", "code") VALUES (1, 7, 'A-7')`);
      await query(`INSERT INTO "mgrg_lines" ("order_code") VALUES ('A-7')`);
      expect(await query(`SELECT "order_code" FROM "mgrg_lines"`)).toEqual([
        { order_code: "A-7" },
      ]);
    });
  });

  it("generates the migration when the relation declares no foreign key constraint", async () => {
    const { up } = await generate(() => {
      const Order = orders();
      @Entity({ name: "mgrg_lines" })
      class Line {
        @PrimaryGeneratedColumn() id!: number;
        @ManyToOne(() => Order, undefined as any, { createForeignKeyConstraints: false })
        @RelationColumn({ name: "order_no", type: "int" } as any)
        order!: InstanceType<typeof Order>;
      }
      return [Order, Line];
    });
    expect(writtenFiles()).toHaveLength(1);

    await onDatabase(async (query) => {
      for (const statement of up) await query(statement);
      expect(await query(`PRAGMA foreign_key_list("mgrg_lines")`)).toEqual([]);
    });
  });
});
