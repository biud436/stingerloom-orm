import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { z } from "zod";

// ── Test Entity ──────────────────────────────────────────

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "int" })
  age!: number;
}

// ── Mock EntityManager ───────────────────────────────────

function createMockEm(mockRows: any[] = []) {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    return `"${col.replace(/"/g, '""')}"`;
  }
  return {
    wrap,
    wrapTable(tableName: string) {
      return wrap(tableName);
    },
    resolver,
    _ctx: {
      isMySqlFamily: () => false,
      isPostgres: () => true,
    },
    async query<T>(): Promise<T[]> {
      return mockRows as T[];
    },
  } as unknown as EntityManager;
}

// ── Tests ─────────────────────────────────────────────────

describe("SelectQueryBuilder — validate()", () => {
  describe("no validator (default)", () => {
    it("should return raw rows without validation", async () => {
      const rows = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];
      const em = createMockEm(rows);
      const qb = new SelectQueryBuilder(User, "u", em);

      const result = await qb.select(["id", "name"]).getPartialMany();
      expect(result).toEqual(rows);
    });

    it("should return raw row from getPartialOne() without validation", async () => {
      const rows = [{ id: 1, name: "Alice" }];
      const em = createMockEm(rows);
      const qb = new SelectQueryBuilder(User, "u", em);

      const result = await qb.select(["id", "name"]).getPartialOne();
      expect(result).toEqual({ id: 1, name: "Alice" });
    });
  });

  describe("plain function validator", () => {
    it("should validate each row with a function", async () => {
      const rows = [
        { id: 1, name: "Alice", age: 25 },
        { id: 2, name: "Bob", age: 30 },
      ];
      const em = createMockEm(rows);
      const validated: any[] = [];

      const result = await new SelectQueryBuilder(User, "u", em)
        .validate((row) => {
          validated.push(row);
          return row;
        })
        .getPartialMany();

      expect(result).toEqual(rows);
      expect(validated).toHaveLength(2);
      expect(validated[0]).toEqual({ id: 1, name: "Alice", age: 25 });
    });

    it("should throw when a row fails validation", async () => {
      const rows = [
        { id: 1, name: "Alice" },
        { id: 2, name: "" },
      ];
      const em = createMockEm(rows);

      await expect(
        new SelectQueryBuilder(User, "u", em)
          .select(["id", "name"])
          .validate((row: any) => {
            if (!row.name) throw new Error("name is required");
            return row;
          })
          .getPartialMany(),
      ).rejects.toThrow("name is required");
    });

    it("should validate getOne() with a function", async () => {
      const rows = [{ id: 1, name: "Alice" }];
      const em = createMockEm(rows);

      const result = await new SelectQueryBuilder(User, "u", em)
        .select(["id", "name"])
        .validate((row) => ({ ...row, validated: true }) as any)
        .getPartialOne();

      expect((result as any).validated).toBe(true);
    });
  });

  describe("zod validator (row-level)", () => {
    const UserRow = z.object({
      id: z.number(),
      name: z.string().min(1),
    });

    it("should validate each row with zod schema", async () => {
      const rows = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];
      const em = createMockEm(rows);

      const result = await new SelectQueryBuilder(User, "u", em)
        .select(["id", "name"])
        .validate(UserRow)
        .getPartialMany();

      expect(result).toEqual(rows);
    });

    it("should throw ZodError when a row fails zod validation", async () => {
      const rows = [
        { id: 1, name: "Alice" },
        { id: "not-a-number", name: "Bad" }, // id is string, not number
      ];
      const em = createMockEm(rows);

      await expect(
        new SelectQueryBuilder(User, "u", em)
          .select(["id", "name"])
          .validate(UserRow)
          .getPartialMany(),
      ).rejects.toThrow(); // ZodError
    });

    it("should strip extra fields with zod .strict()", async () => {
      const StrictRow = z.object({ id: z.number(), name: z.string() }).strict();
      const rows = [{ id: 1, name: "Alice", extraField: "should fail" }];
      const em = createMockEm(rows);

      await expect(
        new SelectQueryBuilder(User, "u", em)
          .select(["id", "name"])
          .validate(StrictRow)
          .getPartialMany(),
      ).rejects.toThrow(); // Unrecognized key
    });

    it("should transform data with zod .transform()", async () => {
      const TransformRow = z.object({
        id: z.number(),
        name: z.string().transform((s) => s.toUpperCase()),
      });
      const rows = [{ id: 1, name: "alice" }];
      const em = createMockEm(rows);

      const result = await new SelectQueryBuilder(User, "u", em)
        .select(["id", "name"])
        .validate(TransformRow)
        .getPartialMany();

      expect(result[0]).toEqual({ id: 1, name: "ALICE" });
    });
  });

  describe("validateArray() — array-level validation", () => {
    it("should validate the entire array with a function", async () => {
      const rows = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];
      const em = createMockEm(rows);

      const result = await new SelectQueryBuilder(User, "u", em)
        .select(["id", "name"])
        .validateArray((arr: any[]) => {
          if (arr.length > 100) throw new Error("too many");
          return arr;
        })
        .getPartialMany();

      expect(result).toEqual(rows);
    });

    it("should throw when array validation fails", async () => {
      const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const em = createMockEm(rows);

      await expect(
        new SelectQueryBuilder(User, "u", em)
          .select(["id"])
          .validateArray((arr: any[]) => {
            if (arr.length > 2) throw new Error("max 2 rows");
            return arr;
          })
          .getPartialMany(),
      ).rejects.toThrow("max 2 rows");
    });

    it("should validate with zod array schema", async () => {
      const UsersArray = z.array(
        z.object({ id: z.number(), name: z.string() }),
      );
      const rows = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];
      const em = createMockEm(rows);

      const result = await new SelectQueryBuilder(User, "u", em)
        .select(["id", "name"])
        .validateArray(UsersArray)
        .getPartialMany();

      expect(result).toEqual(rows);
    });

    it("should throw when zod array validation fails", async () => {
      const UsersArray = z
        .array(z.object({ id: z.number(), name: z.string() }))
        .max(1);
      const rows = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];
      const em = createMockEm(rows);

      await expect(
        new SelectQueryBuilder(User, "u", em)
          .select(["id", "name"])
          .validateArray(UsersArray)
          .getPartialMany(),
      ).rejects.toThrow(); // ZodError: too many items
    });
  });

  describe("combined row + array validation", () => {
    it("should apply row validation first, then array validation", async () => {
      const callOrder: string[] = [];
      const rows = [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ];
      const em = createMockEm(rows);

      const result = await new SelectQueryBuilder(User, "u", em)
        .select(["id", "name"])
        .validate((row: any) => {
          callOrder.push(`row:${row.name}`);
          return { ...row, name: row.name.toUpperCase() };
        })
        .validateArray((arr: any[]) => {
          callOrder.push(`array:${arr.length}`);
          return arr;
        })
        .getPartialMany();

      expect(callOrder).toEqual(["row:alice", "row:bob", "array:2"]);
      expect(result[0]).toEqual({ id: 1, name: "ALICE" });
      expect(result[1]).toEqual({ id: 2, name: "BOB" });
    });
  });

  describe("chaining preserves builder state", () => {
    it("should preserve WHERE and ORDER BY after validate()", async () => {
      const em = createMockEm([]);
      const qb = new SelectQueryBuilder(User, "u", em)
        .select(["id", "name"])
        .where("age", ">=", 18)
        .validate((row) => row)
        .orderBy({ name: "ASC" });

      const { text, values } = qb.getSql();
      expect(text).toContain('"u"."age" >=');
      expect(text).toContain("ORDER BY");
      expect(values).toContain(18);
    });
  });
});
