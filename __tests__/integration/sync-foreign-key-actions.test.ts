/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `synchronize` creates relation foreign keys with their declared `onDelete`
 * / `onUpdate` (MySQL/MariaDB + PostgreSQL).
 *
 * Both drivers' `addForeignKey()` hardcoded `ON DELETE NO ACTION ON UPDATE
 * NO ACTION`, so `@ManyToOne(() => Parent, …, { onDelete: "CASCADE" })`
 * created a constraint that refused to delete the parent instead of taking
 * the children with it — while SQLite's inline constraint and
 * `migrate:generate` honoured the declaration. The catalog is read back and
 * the actions are exercised with real DELETE / UPDATE statements.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";
import { RelationColumn } from "../../src/decorators/RelationColumn";
import { Logger } from "../../src/utils/Logger";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

/** Children before the parent, so DELETE / DROP never trips a constraint. */
const TABLES = [
  "fka_cascade",
  "fka_set_null",
  "fka_plain",
  "fka_profile",
  "fka_strict",
  "fka_parent",
];

describe.each(drivers)(
  "[Integration][$label] synchronize creates foreign keys with their declared actions",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let logs: string[];
    let Parent: new () => any;

    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    async function dropAll(): Promise<void> {
      for (const table of TABLES) await dropTestTable(table);
    }

    beforeAll(async () => {
      logs = [];
      Logger.setOutput((message) => logs.push(message));
      const cleanup = await createTestConnection(
        { ...options, synchronize: false, logging: false },
        () => ({ entities: [] }),
      );
      await dropAll();
      await cleanup.cleanup();

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: "fka_parent" })
          class ParentEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 20 }) name!: string;
          }

          @Entity({ name: "fka_cascade" })
          class CascadeChild {
            @PrimaryGeneratedColumn() id!: number;
            @ManyToOne(() => ParentEntity, () => undefined, {
              onDelete: "CASCADE",
              onUpdate: "CASCADE",
            })
            @RelationColumn({ name: "parent_id" })
            parent!: ParentEntity;
          }

          @Entity({ name: "fka_set_null" })
          class SetNullChild {
            @PrimaryGeneratedColumn() id!: number;
            @ManyToOne(() => ParentEntity, () => undefined, { onDelete: "SET NULL" })
            @RelationColumn({ name: "parent_id" })
            parent!: ParentEntity;
          }

          @Entity({ name: "fka_plain" })
          class PlainChild {
            @PrimaryGeneratedColumn() id!: number;
            @ManyToOne(() => ParentEntity, () => undefined)
            @RelationColumn({ name: "parent_id" })
            parent!: ParentEntity;
          }

          @Entity({ name: "fka_profile" })
          class Profile {
            @PrimaryGeneratedColumn() id!: number;
            @OneToOne(() => ParentEntity, { onDelete: "CASCADE" })
            @RelationColumn({ name: "parent_id" })
            parent!: ParentEntity;
          }

          /** SET NULL on a NOT NULL column: MySQL refuses the constraint. */
          @Entity({ name: "fka_strict" })
          class StrictChild {
            @PrimaryGeneratedColumn() id!: number;
            @ManyToOne(() => ParentEntity, () => undefined, { onDelete: "SET NULL" })
            @RelationColumn({ name: "parent_id", nullable: false })
            parent!: ParentEntity;
          }

          Parent = ParentEntity;
          return {
            entities: [
              ParentEntity,
              CascadeChild,
              SetNullChild,
              PlainChild,
              Profile,
              StrictChild,
            ],
          };
        },
      );
    }, 60000);

    afterAll(async () => {
      Logger.reset();
      await dropAll();
      await conn.cleanup();
    });

    beforeEach(async () => {
      for (const table of TABLES) await rawQuery(`DELETE FROM ${q(table)}`);
    });

    async function rules(table: string): Promise<string[]> {
      const rows = (await conn.em.query(
        type === "postgres"
          ? `SELECT rc.delete_rule AS d, rc.update_rule AS u FROM information_schema.table_constraints tc JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema WHERE tc.table_name = '${table}' AND tc.table_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'`
          : `SELECT DELETE_RULE AS d, UPDATE_RULE AS u FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`,
      )) as unknown as Array<{ d: string; u: string }>;
      return rows.map((r) => `${r.d}/${r.u}`);
    }

    async function count(table: string): Promise<number> {
      const rows = (await conn.em.query(
        `SELECT COUNT(*) AS n FROM ${q(table)}`,
      )) as unknown as Array<{ n: unknown }>;
      return Number(rows[0].n);
    }

    it("records the declared actions in the catalog", async () => {
      expect(await rules("fka_cascade")).toEqual(["CASCADE/CASCADE"]);
      expect(await rules("fka_set_null")).toEqual(["SET NULL/NO ACTION"]);
      expect(await rules("fka_profile")).toEqual(["CASCADE/NO ACTION"]);
      expect(await rules("fka_plain")).toEqual(["NO ACTION/NO ACTION"]);
    });

    it("deleting the parent cascades to the children and nulls the SET NULL key", async () => {
      const parent = await conn.em.save(Parent, { name: "p" });
      await rawQuery(`INSERT INTO ${q("fka_cascade")} (${q("parent_id")}) VALUES (${parent.id})`);
      await rawQuery(`INSERT INTO ${q("fka_profile")} (${q("parent_id")}) VALUES (${parent.id})`);
      await rawQuery(`INSERT INTO ${q("fka_set_null")} (${q("parent_id")}) VALUES (${parent.id})`);

      await rawQuery(`DELETE FROM ${q("fka_parent")} WHERE ${q("id")} = ${parent.id}`);

      expect(await count("fka_cascade")).toBe(0);
      expect(await count("fka_profile")).toBe(0);
      const nulled = (await conn.em.query(
        `SELECT ${q("parent_id")} AS p FROM ${q("fka_set_null")}`,
      )) as unknown as Array<{ p: unknown }>;
      expect(nulled.map((r) => r.p)).toEqual([null]);
    });

    it("updating the parent key cascades to an ON UPDATE CASCADE child", async () => {
      const parent = await conn.em.save(Parent, { name: "p" });
      await rawQuery(`INSERT INTO ${q("fka_cascade")} (${q("parent_id")}) VALUES (${parent.id})`);

      await rawQuery(
        `UPDATE ${q("fka_parent")} SET ${q("id")} = ${parent.id + 1000} WHERE ${q("id")} = ${parent.id}`,
      );

      const moved = (await conn.em.query(
        `SELECT ${q("parent_id")} AS p FROM ${q("fka_cascade")}`,
      )) as unknown as Array<{ p: unknown }>;
      expect(moved.map((r) => Number(r.p))).toEqual([parent.id + 1000]);
    });

    if (type === "mysql") {
      it("reports a constraint the server refuses and keeps booting (continueOnError)", async () => {
        expect(await rules("fka_strict")).toEqual([]);
        expect(
          logs.some(
            (l) =>
              l.includes("Could not create foreign key") &&
              l.includes("fka_strict(parent_id)"),
          ),
        ).toBe(true);
      });
    } else {
      it("creates SET NULL on a NOT NULL column, which PostgreSQL accepts", async () => {
        expect(await rules("fka_strict")).toEqual(["SET NULL/NO ACTION"]);
      });
    }
  },
);
