/**
 * SQLite In-Memory: insertMany / insertManyAndReturn must apply write
 * transformers.
 *
 * Regression: these two batch-insert paths read raw property values and bound
 * them directly, skipping applyWriteTransform — unlike every sibling write path
 * (saveInternal, saveManyBatchInsert, upsert, insertIgnore, batchUpsert). That
 * meant the mandatory JSON stringify and any @Column({ transformer }) never ran,
 * so a JS object bound to a JSON column threw under better-sqlite3 and custom
 * transformer columns were stored raw while reads still applied transformer.from.
 */

import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { generateTableName } from "../helpers/create-test-entity";

describe("[Integration] SQLite: insertMany/insertManyAndReturn apply write transformers", () => {
  let conn: TestConnectionResult;
  let tableName: string;
  let EntityClass: new () => any;

  beforeAll(async () => {
    tableName = generateTableName("ins_xf");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        const DynClass = class {} as any;
        Object.defineProperty(DynClass, "name", {
          value: tableName,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
        PrimaryGeneratedColumn()(DynClass.prototype, "id");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
        Column()(DynClass.prototype, "name");

        // JSON column — the write path must JSON.stringify the JS object.
        Reflect.defineMetadata("design:type", Object, DynClass.prototype, "profile");
        Column({ type: "json", nullable: true })(DynClass.prototype, "profile");

        // Custom transformer column — array stored as a CSV string.
        Reflect.defineMetadata("design:type", Object, DynClass.prototype, "tags");
        Column({
          type: "text",
          nullable: true,
          transformer: {
            to: (v: string[] | null | undefined) =>
              v && v.length ? v.join(",") : null,
            from: (v: string | null) => (v ? v.split(",") : []),
          },
        })(DynClass.prototype, "tags");

        Entity()(DynClass);
        EntityClass = DynClass;
        return { entities: [DynClass] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("insertMany() stringifies JSON columns and applies the custom transformer", async () => {
    const { em } = conn;

    await em.insertMany(EntityClass, [
      { name: "alice", profile: { role: "admin", level: 3 }, tags: ["x", "y"] },
      { name: "bob", profile: { role: "viewer" }, tags: ["z"] },
    ]);

    const alice = await em.findOne(EntityClass, { where: { name: "alice" } as any });
    expect(alice).toBeDefined();
    // JSON round-trips back to a parsed object, not "[object Object]".
    expect(alice!.profile).toEqual({ role: "admin", level: 3 });
    // Custom transformer round-trips the array.
    expect(alice!.tags).toEqual(["x", "y"]);
  });

  it("insertManyAndReturn() applies the same transforms on the returned rows", async () => {
    const { em } = conn;

    const rows = await em.insertManyAndReturn(EntityClass, [
      { name: "carol", profile: { role: "editor", flags: [1, 2] }, tags: ["a"] },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].profile).toEqual({ role: "editor", flags: [1, 2] });
    expect(rows[0].tags).toEqual(["a"]);

    // And re-reading from the DB confirms it was persisted correctly.
    const carol = await em.findOne(EntityClass, { where: { name: "carol" } as any });
    expect(carol!.profile).toEqual({ role: "editor", flags: [1, 2] });
    expect(carol!.tags).toEqual(["a"]);
  });
});
