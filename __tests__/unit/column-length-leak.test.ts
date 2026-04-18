/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression: the length default inferred from `design:type` must not
 * leak across an explicit `@Column({ type: ... })` override.
 *
 * Before the fix: `design:type=String` seeded `length: 255`, so
 * `@Column({ type: "date" })` silently produced `DATE(255)` on MySQL —
 * invalid DDL. The fix drops the inherited length when the user
 * explicitly overrides the type without providing a length.
 *
 * Also verifies that dialect builders emit `(n)` only for types that
 * actually accept it, so a user accidentally passing `length: 255`
 * alongside `type: "date"` doesn't produce broken SQL either.
 */

import "reflect-metadata";
import { Column, COLUMN_TOKEN } from "../../src/decorators/Column";
import { MySqlColumnDefinitionBuilder } from "../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";

function readResolvedOption(target: any, propertyKey: string) {
  const columns: any[] = Reflect.getMetadata(COLUMN_TOKEN, target) ?? [];
  const entry = columns.find((c) => c.propertyKey === propertyKey);
  return entry?.options;
}

describe("@Column type override no longer leaks inferred length", () => {
  it("String design:type + @Column({type:'date'}) drops the 255 default", () => {
    const Cls = class {} as any;
    Reflect.defineMetadata("design:type", String, Cls.prototype, "soldOn");
    Column({ type: "date" })(Cls.prototype, "soldOn");

    const option = readResolvedOption(Cls.prototype, "soldOn");
    expect(option.type).toBe("date");
    expect(option.length).toBeUndefined();
  });

  it("String design:type + matching @Column({type:'varchar'}) keeps 255", () => {
    const Cls = class {} as any;
    Reflect.defineMetadata("design:type", String, Cls.prototype, "name");
    Column({ type: "varchar" })(Cls.prototype, "name");

    const option = readResolvedOption(Cls.prototype, "name");
    expect(option).toMatchObject({ type: "varchar", length: 255 });
  });

  it("String design:type + @Column({type:'date', length: 6}) preserves user length", () => {
    const Cls = class {} as any;
    Reflect.defineMetadata("design:type", String, Cls.prototype, "t");
    Column({ type: "date", length: 6 })(Cls.prototype, "t");

    const option = readResolvedOption(Cls.prototype, "t");
    expect(option).toMatchObject({ type: "date", length: 6 });
  });

  it("Number design:type + @Column({type:'bigint'}) drops int's 11 default", () => {
    const Cls = class {} as any;
    Reflect.defineMetadata("design:type", Number, Cls.prototype, "big");
    Column({ type: "bigint" })(Cls.prototype, "big");

    const option = readResolvedOption(Cls.prototype, "big");
    expect(option.type).toBe("bigint");
    expect(option.length).toBeUndefined();
  });
});

describe("buildColumnDef: length must not be emitted for types that reject it", () => {
  describe("MySQL", () => {
    const b = () => new MySqlColumnDefinitionBuilder();

    it.each([
      ["date",      "DATE"],
      ["datetime",  "DATETIME"],
      ["timestamp", "TIMESTAMP"],
      ["text",      "TEXT"],
      ["longtext",  "LONGTEXT"],
      ["blob",      "BLOB"],
      ["json",      "JSON"],
      ["float",     "FLOAT"],
    ] as const)(
      "type:%s + stray length: 255  →  emits %s (no length)",
      (type, expected) => {
        const ddl = b().buildColumnDef(
          { type, length: 255, nullable: false } as any,
          { columnName: "c", tableName: "t" },
        );
        expect(ddl).toContain(expected);
        expect(ddl).not.toMatch(new RegExp(`${expected}\\s*\\(`));
      },
    );

    it("varchar still accepts length", () => {
      const ddl = b().buildColumnDef(
        { type: "varchar", length: 50, nullable: false },
        { columnName: "n", tableName: "t" },
      );
      expect(ddl).toMatch(/VARCHAR\(50\)/);
    });

    it("int keeps display width when explicitly requested", () => {
      const ddl = b().buildColumnDef(
        { type: "int", length: 11, nullable: false },
        { columnName: "i", tableName: "t" },
      );
      expect(ddl).toMatch(/INT\(11\)/);
    });
  });

  describe("PostgreSQL", () => {
    const b = () => new PostgresColumnDefinitionBuilder();

    it.each([
      "date", "datetime", "timestamp", "text", "blob", "json",
      "float", "double", "int", "bigint", "boolean",
    ] as const)("type:%s + stray length: 255  →  no (255)", (type) => {
      const ddl = b().buildColumnDef(
        { type, length: 255, nullable: false } as any,
        { columnName: "c", tableName: "t" },
      );
      expect(ddl).not.toMatch(/\b255\b/);
    });

    it("varchar still accepts length", () => {
      const ddl = b().buildColumnDef(
        { type: "varchar", length: 50, nullable: false },
        { columnName: "n", tableName: "t" },
      );
      expect(ddl).toMatch(/VARCHAR\(50\)/);
    });
  });

  describe("SQLite", () => {
    const b = () => new SqliteColumnDefinitionBuilder();

    it.each([
      "date", "datetime", "timestamp", "json", "blob",
      "float", "double", "int", "bigint", "boolean",
    ] as const)("type:%s + stray length: 255  →  no (255)", (type) => {
      const ddl = b().buildColumnDef(
        { type, length: 255, nullable: false } as any,
        { columnName: "c", tableName: "t" },
      );
      expect(ddl).not.toMatch(/\b255\b/);
    });

    it("varchar keeps length (emitted as TEXT(n))", () => {
      const ddl = b().buildColumnDef(
        { type: "varchar", length: 50, nullable: false },
        { columnName: "n", tableName: "t" },
      );
      expect(ddl).toMatch(/TEXT\(50\)/);
    });
  });
});
