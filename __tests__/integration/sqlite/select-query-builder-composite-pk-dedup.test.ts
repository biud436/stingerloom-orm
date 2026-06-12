/**
 * SQLite integration test for COMPOSITE-PK dedup in to-many *AndSelect
 * hydration.
 *
 * transformJoinedEntityRows() dedups joined children by a key built from their
 * PK column values (pkKeyOf(), SelectQueryBuilder.ts ~line 4214). For composite
 * PKs the values are joined with a control-char separator (U+0001), so children
 * whose values would concatenate to the same string WITHOUT a separator
 * (e.g. ("a","bc") and ("ab","c") both -> "abc") must still be treated as
 * distinct.
 *
 * This drives two to-many *AndSelect joins on the same root to force a
 * cartesian product, which exercises both halves of the dedup contract:
 *   - the SAME child repeated across cartesian rows collapses to one entry,
 *   - two DISTINCT composite-PK children that collide under naive concatenation
 *     are NOT wrongly merged.
 *
 * Guarded like its siblings: only runs under INTEGRATION_TEST=true.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortTableName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
}

describe("[Integration] SQLite In-Memory: composite-PK to-many dedup", () => {
  let conn: TestConnectionResult;
  let Box: new () => any;
  let Item: new () => any;
  let Tag: new () => any;
  let boxTable = "";
  let itemTable = "";
  let tagTable = "";

  beforeAll(async () => {
    boxTable = shortTableName("cp_box");
    itemTable = shortTableName("cp_item");
    tagTable = shortTableName("cp_tag");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const BX = class {} as any;
        Object.defineProperty(BX, "name", { value: boxTable, writable: false });
        Reflect.defineMetadata("design:type", Number, BX.prototype, "id");
        PrimaryGeneratedColumn()(BX.prototype, "id");
        Reflect.defineMetadata("design:type", String, BX.prototype, "label");
        Column()(BX.prototype, "label");
        Reflect.defineMetadata("design:type", Array, BX.prototype, "items");
        OneToMany(() => IT, { mappedBy: "box" })(BX.prototype, "items");
        Reflect.defineMetadata("design:type", Array, BX.prototype, "tags");
        OneToMany(() => TG, { mappedBy: "box" })(BX.prototype, "tags");
        Entity()(BX);

        const IT = class {} as any;
        Object.defineProperty(IT, "name", { value: itemTable, writable: false });
        Reflect.defineMetadata("design:type", String, IT.prototype, "k1");
        PrimaryColumn({ type: "varchar" })(IT.prototype, "k1");
        Reflect.defineMetadata("design:type", String, IT.prototype, "k2");
        PrimaryColumn({ type: "varchar" })(IT.prototype, "k2");
        Reflect.defineMetadata("design:type", Number, IT.prototype, "boxFk");
        Column({ type: "int", nullable: true })(IT.prototype, "boxFk");
        Reflect.defineMetadata("design:type", BX, IT.prototype, "box");
        ManyToOne(() => BX, (e: any) => e.box, { joinColumn: "boxFk" })(
          IT.prototype,
          "box",
        );
        Entity()(IT);

        const TG = class {} as any;
        Object.defineProperty(TG, "name", { value: tagTable, writable: false });
        Reflect.defineMetadata("design:type", Number, TG.prototype, "id");
        PrimaryGeneratedColumn()(TG.prototype, "id");
        Reflect.defineMetadata("design:type", String, TG.prototype, "name");
        Column()(TG.prototype, "name");
        Reflect.defineMetadata("design:type", Number, TG.prototype, "boxFk");
        Column({ type: "int", nullable: true })(TG.prototype, "boxFk");
        Reflect.defineMetadata("design:type", BX, TG.prototype, "box");
        ManyToOne(() => BX, (e: any) => e.box, { joinColumn: "boxFk" })(
          TG.prototype,
          "box",
        );
        Entity()(TG);

        Box = BX;
        Item = IT;
        Tag = TG;
        return { entities: [BX, IT, TG] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${boxTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "label" TEXT NOT NULL DEFAULT ''
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${itemTable}" (
        "k1" TEXT NOT NULL,
        "k2" TEXT NOT NULL,
        "boxFk" INTEGER,
        PRIMARY KEY ("k1", "k2")
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${tagTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL DEFAULT '',
        "boxFk" INTEGER
      )
    `);

    const { em } = conn;
    const box = await em.save(Box, { label: "B1" });

    // Two distinct composite-PK children whose values concatenate to the same
    // string ("a"+"bc" === "ab"+"c" === "abc") without a separator. box.id is
    // a generated integer, inlined safely into this test-only raw SQL.
    await connector.query(
      `INSERT INTO "${itemTable}" ("k1", "k2", "boxFk") VALUES ('a', 'bc', ${box.id}), ('ab', 'c', ${box.id})`,
    );
    // Two tags, so the items <-> tags join is a 2x2 cartesian (4 rows).
    await connector.query(
      `INSERT INTO "${tagTable}" ("name", "boxFk") VALUES ('t1', ${box.id}), ('t2', ${box.id})`,
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("dedups composite-PK children across a cartesian and never merges colliding PKs", async () => {
    const boxes = await conn.em
      .createQueryBuilder(Box, "b")
      .leftJoinRelationAndSelect("items", "i")
      .leftJoinRelationAndSelect("tags", "t")
      .getMany();

    expect(boxes).toHaveLength(1);
    const box = boxes[0];

    // The 2x2 cartesian repeats each item twice; dedup must collapse to 2
    // (not 4), and the colliding composite PKs must NOT be merged into 1.
    expect(box.items).toHaveLength(2);
    const pkPairs = new Set(box.items.map((i: any) => `${i.k1}|${i.k2}`));
    expect(pkPairs).toEqual(new Set(["a|bc", "ab|c"]));

    // The other to-many also dedups across the cartesian (2 tags, not 4).
    expect(box.tags).toHaveLength(2);
    const tagNames = new Set(box.tags.map((t: any) => t.name));
    expect(tagNames).toEqual(new Set(["t1", "t2"]));
  });
});
