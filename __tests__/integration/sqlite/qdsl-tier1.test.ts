/**
 * SQLite integration tests for QueryDSL Tier 1.
 *
 * Covers the new expression types end-to-end against a real SQLite database:
 *  - OrderExpression (asc/desc + nullsFirst/nullsLast)
 *  - AggregateExpression in SELECT and HAVING
 *  - LogicalCondition composition in WHERE
 *  - ColumnExpression string convenience (startsWith/contains/*IgnoreCase)
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";
import { qAlias } from "../../../src/core/SelectQueryBuilder";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { generateTableName } from "../helpers/create-test-entity";

interface EmployeeShape {
  id: number;
  name: string;
  email: string;
  departmentId: number;
  role: string;
  salary: number | null;
  status: string;
}

describe("[Integration] SQLite In-Memory: QueryDSL Tier 1", () => {
  let conn: TestConnectionResult;
  let Employee: new () => EmployeeShape;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("qdsl_tier1");

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
        Column({ type: "varchar", length: 255 })(DynClass.prototype, "name");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "email");
        Column({ type: "varchar", length: 255 })(DynClass.prototype, "email");

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "departmentId");
        Column({ type: "int" })(DynClass.prototype, "departmentId");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "role");
        Column({ type: "varchar", length: 50 })(DynClass.prototype, "role");

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "salary");
        Column({ type: "int", nullable: true })(DynClass.prototype, "salary");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "status");
        Column({ type: "varchar", length: 20 })(DynClass.prototype, "status");

        Entity()(DynClass);
        Employee = DynClass;
        return { entities: [DynClass] };
      },
    );

    const { em } = conn;
    await em.save(Employee, { name: "Alice",   email: "alice@example.com",  departmentId: 1, role: "admin",  salary: 100, status: "active" });
    await em.save(Employee, { name: "Bob",     email: "BOB@example.com",    departmentId: 1, role: "user",   salary: 80,  status: "active" });
    await em.save(Employee, { name: "Charlie", email: "charlie@GMAIL.com",  departmentId: 2, role: "user",   salary: 90,  status: "inactive" });
    await em.save(Employee, { name: "Dave",    email: "dave@example.com",   departmentId: 2, role: "admin",  salary: null, status: "active" });
    await em.save(Employee, { name: "Eve",     email: "eve@gmail.com",      departmentId: 2, role: "owner",  salary: 120, status: "active" });
    await em.save(Employee, { name: "Frank",   email: "frank@company.net",  departmentId: 3, role: "user",   salary: 60,  status: "active" });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  // ── Aggregates in SELECT ──────────────────────────────────

  describe("Aggregate in SELECT", () => {
    it("COUNT aggregate returns total rows", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.select(e.id.count().as("total")).getRawMany();
      expect(rows.length).toBe(1);
      expect(Number(rows[0].total)).toBe(6);
    });

    it("SUM / AVG / MIN / MAX in one SELECT", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .select([
          e.salary.sum().as("total"),
          e.salary.avg().as("average"),
          e.salary.min().as("low"),
          e.salary.max().as("high"),
        ])
        .getRawMany();
      expect(Number(rows[0].total)).toBe(450); // 100+80+90+120+60 (Dave's null excluded)
      expect(Number(rows[0].low)).toBe(60);
      expect(Number(rows[0].high)).toBe(120);
    });

    it("COUNT(DISTINCT col)", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .select(e.role.countDistinct().as("distinct_roles"))
        .getRawMany();
      expect(Number(rows[0].distinct_roles)).toBe(3); // admin, user, owner
    });

    it("addSelect(aggregate) appends alongside entity columns", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .select(["departmentId"])
        .addSelect(e.id.count().as("cnt"))
        .groupBy(["e.departmentId"])
        .addOrderBy("e.departmentId", "ASC")
        .getRawMany();
      expect(rows.length).toBe(3);
      expect(rows.map((r) => Number(r.cnt))).toEqual([2, 3, 1]);
    });
  });

  // ── GROUP BY + HAVING ────────────────────────────────────

  describe("HAVING with AggregateCondition", () => {
    it("HAVING COUNT(id) >= N filters groups", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const cnt = e.id.count();
      const rows = await qb
        .select(["departmentId"])
        .addSelect(cnt.as("cnt"))
        .groupBy(["e.departmentId"])
        .having(cnt.gte(2))
        .addOrderBy("e.departmentId", "ASC")
        .getRawMany();
      // Only departments 1 (2) and 2 (3) satisfy >= 2
      expect(rows.length).toBe(2);
    });

    it("HAVING with .and() chains two aggregate bounds", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const sal = e.salary.sum();
      const rows = await qb
        .select(["departmentId"])
        .addSelect(sal.as("total"))
        .groupBy(["e.departmentId"])
        .having(sal.gte(100).and(sal.lt(350)))
        .addOrderBy("e.departmentId", "ASC")
        .getRawMany();
      // Dept 1: 180. Dept 2: 210 (null excluded). Dept 3: 60.
      // 100 <= total < 350 → dept 1 (180) and dept 2 (210)
      expect(rows.length).toBe(2);
      expect(rows.map((r) => Number(r.total)).sort((a, b) => a - b)).toEqual([180, 210]);
    });
  });

  // ── WHERE logical composition ────────────────────────────

  describe("WHERE with .and()/.or()/.not()", () => {
    it("a.and(b) selects rows matching both", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(e.status.eq("active").and(e.role.eq("admin")))
        .getMany();
      const names = rows.map((r: any) => r.name).sort();
      expect(names).toEqual(["Alice", "Dave"]);
    });

    it("a.or(b) selects rows matching either", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(e.role.eq("admin").or(e.role.eq("owner")))
        .getMany();
      const names = rows.map((r: any) => r.name).sort();
      expect(names).toEqual(["Alice", "Dave", "Eve"]);
    });

    it("NOT negates a condition", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(e.salary.isNull().not())
        .getMany();
      // Everyone except Dave (salary=null)
      expect(rows.length).toBe(5);
    });

    it("Expressions.or(and(a, b), c) preserves explicit grouping", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(
          Expressions.or(
            Expressions.and(e.status.eq("active"), e.role.eq("admin")),
            e.role.eq("owner"),
          ),
        )
        .getMany();
      const names = rows.map((r: any) => r.name).sort();
      // active+admin: Alice, Dave. owner: Eve.
      expect(names).toEqual(["Alice", "Dave", "Eve"]);
    });
  });

  // ── ORDER BY ─────────────────────────────────────────────

  describe("ORDER BY with OrderExpression", () => {
    it("orderBy(col.desc())", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.orderBy(e.name.desc()).getMany();
      const names = rows.map((r: any) => r.name);
      expect(names[0]).toBe("Frank");
      expect(names[names.length - 1]).toBe("Alice");
    });

    it("addOrderBy chains multiple sort keys", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .addOrderBy(e.departmentId.asc())
        .addOrderBy(e.name.asc())
        .getMany();
      expect(rows[0].name).toBe("Alice"); // dept 1
      expect(rows[rows.length - 1].name).toBe("Frank"); // dept 3
    });

    it("asc().nullsLast() puts null-salary rows at the end", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.orderBy(e.salary.asc().nullsLast()).getMany();
      expect(rows[rows.length - 1].name).toBe("Dave");
      expect(rows[0].salary).toBe(60);
    });

    it("desc().nullsFirst() floats nulls to the top", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.orderBy(e.salary.desc().nullsFirst()).getMany();
      expect(rows[0].name).toBe("Dave");
      expect(rows[rows.length - 1].salary).toBe(60);
    });
  });

  // ── String convenience ───────────────────────────────────

  describe("String convenience", () => {
    it("startsWith filters by prefix", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.name.startsWith("C")).getMany();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Charlie");
    });

    it("endsWith filters by suffix", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.name.endsWith("e")).getMany();
      // Alice, Charlie, Dave, Eve
      const names = rows.map((r: any) => r.name).sort();
      expect(names).toEqual(["Alice", "Charlie", "Dave", "Eve"]);
    });

    it("contains finds substring", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.email.contains("example.com")).getMany();
      const names = rows.map((r: any) => r.name).sort();
      // alice, bob, dave — but bob's email is "BOB@example.com" (upper-case BOB,
      // lower-case @example.com domain matches case-sensitively in SQLite LIKE
      // for the substring)
      expect(names).toEqual(["Alice", "Bob", "Dave"]);
    });

    it("containsIgnoreCase matches across case variants", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.email.containsIgnoreCase("@GMAIL")).getMany();
      const names = rows.map((r: any) => r.name).sort();
      // Charlie (charlie@GMAIL.com) and Eve (eve@gmail.com)
      expect(names).toEqual(["Charlie", "Eve"]);
    });

    it("equalsIgnoreCase matches regardless of case", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(e.email.equalsIgnoreCase("ALICE@example.COM"))
        .getMany();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice");
    });

    it("startsWith escapes wildcard metacharacters", async () => {
      // Insert a row whose name contains a literal '%' and '_'
      await conn.em.save(Employee, {
        name: "50%_discount",
        email: "promo@example.com",
        departmentId: 4,
        role: "user",
        salary: 50,
        status: "active",
      });
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.name.startsWith("50%")).getMany();
      // Must match only the literal "50%_discount" row, not any row that
      // happens to start with "50" followed by any character.
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("50%_discount");
    });
  });

  // ── Combined flows ───────────────────────────────────────

  describe("Combined: SELECT aggregates + HAVING + ORDER BY", () => {
    it("top-N departments by headcount", async () => {
      const qb = conn.em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const cnt = e.id.count();
      const rows = await qb
        .select(["departmentId"])
        .addSelect(cnt.as("headcount"))
        .groupBy(["e.departmentId"])
        .having(cnt.gte(2))
        .addOrderBy(e.departmentId.asc())
        .getRawMany();
      // dept 1: 2, dept 2: 3
      expect(rows.length).toBe(2);
      expect(rows.map((r) => Number(r.headcount))).toEqual([2, 3]);
    });
  });
});
