/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A relation's `onDelete` / `onUpdate` outside the SQL actions stops
 * `synchronize` before any DDL runs.
 *
 * The action is spliced into the FOREIGN KEY clause. SQLite's inline clause
 * used to drop an unknown one, so the constraint silently fell back to
 * NO ACTION; routed through CREATE TABLE's error handling it would now
 * surface only as a "Failed to create table" warning. It is a mistake in the
 * entity, not a failing statement, so it throws whatever `continueOnError`
 * says. The PostgreSQL / MySQL counterparts are in
 * __tests__/integration/sync-foreign-key-actions.test.ts.
 */
import "reflect-metadata";
import {
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
} from "../../../src";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { createTestConnection } from "../helpers/test-connection";

describe("[Integration] SQLite: synchronize validates relation actions", () => {
  const sqlite = { type: "sqlite", database: ":memory:", logging: false } as any;

  function entities(action: string, kind: "manyToOne" | "oneToOne" = "manyToOne") {
    return () => {
      @Entity({ name: "fkv_parent" })
      class Parent {
        @PrimaryGeneratedColumn() id!: number;
      }

      if (kind === "manyToOne") {
        @Entity({ name: "fkv_child" })
        class Child {
          @PrimaryGeneratedColumn() id!: number;
          @ManyToOne(() => Parent, () => undefined, { onDelete: action as any })
          @RelationColumn({ name: "parent_id" })
          parent!: Parent;
        }
        return { entities: [Parent, Child] };
      }

      @Entity({ name: "fkv_child" })
      class Child {
        @PrimaryGeneratedColumn() id!: number;
        @OneToOne(() => Parent, { onUpdate: action as any })
        @RelationColumn({ name: "parent_id" })
        parent!: Parent;
      }
      return { entities: [Parent, Child] };
    };
  }

  it("keeps a whitelisted action on the inline constraint", async () => {
    const conn = await createTestConnection(
      { ...sqlite, synchronize: true },
      entities("SET NULL"),
    );
    try {
      const fks = (await conn.em.query(
        `PRAGMA foreign_key_list("fkv_child")`,
      )) as unknown as Array<{ on_delete: string }>;
      expect(fks.map((fk) => fk.on_delete)).toEqual(["SET NULL"]);
    } finally {
      await conn.cleanup();
    }
  });

  it.each([
    ["@ManyToOne onDelete", "manyToOne", /Invalid ON DELETE action "CASCADES"/],
    ["@OneToOne onUpdate", "oneToOne", /Invalid ON UPDATE action "CASCADES"/],
  ] as const)("throws for an unknown %s, even with continueOnError", async (_label, kind, message) => {
    try {
      await expect(
        createTestConnection(
          {
            ...sqlite,
            synchronize: { mode: true, continueOnError: true },
          },
          entities("CASCADES", kind),
        ),
      ).rejects.toThrow(message);
    } finally {
      await DatabaseClient.getInstance().close();
    }
  });

  it("does not look at the action when synchronize is off", async () => {
    const conn = await createTestConnection(
      { ...sqlite, synchronize: false },
      entities("CASCADES"),
    );
    await conn.cleanup();
  });
});
