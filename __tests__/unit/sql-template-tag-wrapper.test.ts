import * as fs from "fs";
import * as path from "path";
import sqlDefault, { sql, Sql, raw, join, empty } from "../../src/utils/sqlTag";

const SRC = path.join(__dirname, "..", "..", "src");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
      files.push(full);
  }
  return files;
}

describe("sqlTag wrapper", () => {
  it("unwraps the tag function in both module systems", () => {
    expect(typeof sql).toBe("function");
    expect(sqlDefault).toBe(sql);

    const query = sql`SELECT * FROM t WHERE id = ${1}`;
    expect(query).toBeInstanceOf(Sql);
    expect(query.values).toEqual([1]);

    expect(typeof raw).toBe("function");
    expect(typeof join).toBe("function");
    expect(empty).toBeInstanceOf(Sql);
  });

  describe("bigint values", () => {
    it("binds a BigInt as a parameter, unchanged", () => {
      const query = sql`SELECT * FROM t WHERE id = ${9007199254740993n}`;
      expect(query.sql).toBe("SELECT * FROM t WHERE id = ?");
      expect(query.values).toEqual([9007199254740993n]);
    });

    it("joins BigInt values and keeps them through a nested fragment", () => {
      const query = sql`SELECT * FROM t WHERE id IN (${join([1n, 2n])})`;
      expect(query.sql).toBe("SELECT * FROM t WHERE id IN (?,?)");
      expect(query.values).toEqual([1n, 2n]);
    });

    it("still rejects a value no driver binds", () => {
      const bind = (value: symbol) =>
        // @ts-expect-error a symbol is not a bindable value
        sql`SELECT ${value}`;
      expect(typeof bind).toBe("function");
    });
  });

  /**
   * The ESM build breaks on direct default imports of sql-template-tag (a
   * CJS package whose default binding becomes module.exports under Node
   * ESM). Every runtime import must go through utils/sqlTag.ts instead.
   * Type-position `import("sql-template-tag").Sql` is fine — it is erased.
   */
  it("is the only module importing sql-template-tag directly", () => {
    const offenders = walk(SRC).filter((file) => {
      if (file.endsWith(path.join("utils", "sqlTag.ts"))) return false;
      return fs.readFileSync(file, "utf8").includes('from "sql-template-tag"');
    });

    expect(offenders).toEqual([]);
  });
});
