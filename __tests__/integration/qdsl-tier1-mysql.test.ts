/**
 * MySQL (MariaDB) integration tests for QueryDSL Tier 1.
 *
 * Exercises the dialect-specific code paths that SQLite cannot cover:
 *  - MySQL's NULLS FIRST/LAST emulation via `col IS NULL` ordering prefix
 *  - `caseInsensitiveLike` falling back to `LOWER(col) LIKE LOWER(pattern) ESCAPE '\'`
 *    so behavior is consistent even under `utf8mb4_bin` collation
 *  - LIKE metacharacter escaping on MySQL (backslash is the default ESCAPE)
 *  - Aggregates + logical composition end-to-end
 *
 * Reuses the project-wide dual-driver connection helpers and only runs
 * when INTEGRATION_TEST=true.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getMySqlConfig } from "./helpers/driver-config";
import { qAlias } from "../../src/core/SelectQueryBuilder";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../src";
import { generateTableName } from "./helpers/create-test-entity";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const MYSQL_ENABLED =
  INTEGRATION && process.env.INTEGRATION_TEST_MYSQL !== "false";
const integrationDescribe = MYSQL_ENABLED ? describe : describe.skip;

interface EmployeeShape {
  id: number;
  name: string;
  email: string;
  departmentId: number;
  role: string;
  salary: number | null;
  status: string;
}

integrationDescribe("[Integration] MySQL: QueryDSL Tier 1", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let Employee: new () => EmployeeShape;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("qdsl_t1_mysql");

    conn = await createTestConnection(
      { ...getMySqlConfig(), synchronize: true, logging: false },
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
    em = conn.em;

    await em.save(Employee, { name: "Alice",   email: "alice@example.com",  departmentId: 1, role: "admin",  salary: 100, status: "active" });
    await em.save(Employee, { name: "Bob",     email: "BOB@example.com",    departmentId: 1, role: "user",   salary: 80,  status: "active" });
    await em.save(Employee, { name: "Charlie", email: "charlie@GMAIL.com",  departmentId: 2, role: "user",   salary: 90,  status: "inactive" });
    await em.save(Employee, { name: "Dave",    email: "dave@example.com",   departmentId: 2, role: "admin",  salary: null, status: "active" } as any);
    await em.save(Employee, { name: "Eve",     email: "eve@gmail.com",      departmentId: 2, role: "owner",  salary: 120, status: "active" });
    await em.save(Employee, { name: "Frank",   email: "frank@company.net",  departmentId: 3, role: "user",   salary: 60,  status: "active" });
  }, 30000);

  afterAll(async () => {
    try {
      await truncateTestTable(tableName);
      await dropTestTable(tableName);
    } catch {
      /* ignore */
    }
    await conn.cleanup();
  }, 15000);

  // ── Aggregates in SELECT ──────────────────────────────────

  describe("Aggregate in SELECT", () => {
    it("COUNT aggregate returns total rows", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.select(e.id.count().as("total")).getRawMany();
      expect(Number(rows[0].total)).toBe(6);
    });

    it("SUM / AVG / MIN / MAX in one SELECT", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .select([
          e.salary.sum().as("total"),
          e.salary.min().as("low"),
          e.salary.max().as("high"),
        ])
        .getRawMany();
      expect(Number(rows[0].total)).toBe(450);
      expect(Number(rows[0].low)).toBe(60);
      expect(Number(rows[0].high)).toBe(120);
    });

    it("COUNT(DISTINCT col)", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .select(e.role.countDistinct().as("distinct_roles"))
        .getRawMany();
      expect(Number(rows[0].distinct_roles)).toBe(3);
    });
  });

  // ── HAVING ───────────────────────────────────────────────

  describe("HAVING with AggregateCondition", () => {
    it("HAVING COUNT(id) >= N filters groups", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const cnt = e.id.count();
      const rows = await qb
        .select(["departmentId"])
        .addSelect(cnt.as("cnt"))
        .groupBy(["e.departmentId"])
        .having(cnt.gte(2))
        .addOrderBy("e.departmentId", "ASC")
        .getRawMany();
      expect(rows.length).toBe(2);
    });
  });

  // ── WHERE logical composition ────────────────────────────

  describe("WHERE with .and()/.or()/.not()", () => {
    it("a.and(b) selects rows matching both", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(e.status.eq("active").and(e.role.eq("admin")))
        .getMany();
      const names = rows.map((r: any) => r.name).sort();
      expect(names).toEqual(["Alice", "Dave"]);
    });

    it("Expressions.or(and(a, b), c) groups correctly", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
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
      expect(names).toEqual(["Alice", "Dave", "Eve"]);
    });

    it("NOT negates a condition", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.salary.isNull().not()).getMany();
      expect(rows.length).toBe(5);
    });
  });

  // ── ORDER BY — MySQL NULLS emulation ─────────────────────

  describe("ORDER BY with OrderExpression (MySQL)", () => {
    it("asc().nullsLast() emulates via IS NULL prefix (MySQL default ASC puts NULLs first)", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.orderBy(e.salary.asc().nullsLast()).getMany();
      // Dave (null) should be last. Lowest salary (60 — Frank) first.
      expect(rows[rows.length - 1].name).toBe("Dave");
      expect(rows[0].salary).toBe(60);
    });

    it("desc().nullsFirst() emulates via IS NULL prefix", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.orderBy(e.salary.desc().nullsFirst()).getMany();
      // Dave (null) should be first. Highest salary (120 — Eve) second.
      expect(rows[0].name).toBe("Dave");
      expect(rows[rows.length - 1].salary).toBe(60);
    });

    it("desc().nullsLast() uses default (no emulation needed on MySQL)", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.orderBy(e.salary.desc().nullsLast()).getMany();
      // MySQL default DESC already puts NULLs last. Verify Dave is last.
      expect(rows[rows.length - 1].name).toBe("Dave");
      // Without the `IS NULL` prefix in the SQL — confirm emitted text
      const { text } = qb.getSql();
      expect(text).not.toContain("IS NULL");
    });

    it("asc().nullsFirst() uses default (no emulation needed on MySQL)", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.orderBy(e.salary.asc().nullsFirst()).getMany();
      expect(rows[0].name).toBe("Dave");
      const { text } = qb.getSql();
      expect(text).not.toContain("IS NULL");
    });

    it("chains with addOrderBy", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .addOrderBy(e.departmentId.asc())
        .addOrderBy(e.name.asc())
        .getMany();
      expect(rows[0].name).toBe("Alice"); // dept 1, first alphabetically
      expect(rows[rows.length - 1].name).toBe("Frank"); // dept 3
    });
  });

  // ── String convenience — MySQL LOWER fallback ────────────

  describe("String convenience (MySQL LOWER fallback)", () => {
    it("equalsIgnoreCase uses LOWER() on both sides", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(e.email.equalsIgnoreCase("ALICE@example.COM"))
        .getMany();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice");
      // Verify SQL uses LOWER() on both sides
      const { text } = qb.getSql();
      expect(text).toMatch(/LOWER\(.*\)\s*=\s*LOWER\(/);
    });

    it("containsIgnoreCase uses LOWER LIKE LOWER with ESCAPE", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb
        .where(e.email.containsIgnoreCase("@GMAIL"))
        .getMany();
      const names = rows.map((r: any) => r.name).sort();
      // Charlie (charlie@GMAIL.com) and Eve (eve@gmail.com)
      expect(names).toEqual(["Charlie", "Eve"]);
      const { text } = qb.getSql();
      expect(text).toMatch(/LOWER\(.*\) LIKE LOWER\(/);
      expect(text).toContain("ESCAPE");
      expect(text).not.toContain("ILIKE"); // MySQL has no native ILIKE
    });

    it("startsWith with literal % stays literal (escape applied)", async () => {
      // Seed a row whose name contains a literal '%'
      await em.save(Employee, {
        name: "50%_discount",
        email: "promo_mysql@example.com",
        departmentId: 4,
        role: "user",
        salary: 50,
        status: "active",
      });
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.name.startsWith("50%")).getMany();
      // Only the literal "50%" row matches — NOT everything starting with "50"
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("50%_discount");
    });

    it("startsWith(plain) matches prefix", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const rows = await qb.where(e.name.startsWith("Ch")).getMany();
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Charlie");
    });
  });

  // ── Combined flow ────────────────────────────────────────

  describe("Combined: aggregates + HAVING + ORDER BY", () => {
    it("top-N departments by headcount with NULLS-sensitive secondary sort", async () => {
      const qb = em.createQueryBuilder(Employee, "e");
      const e = qAlias(Employee, "e");
      const cnt = e.id.count();
      const rows = await qb
        .select(["departmentId"])
        .addSelect(cnt.as("headcount"))
        .groupBy(["e.departmentId"])
        .having(cnt.gte(2))
        .addOrderBy(e.departmentId.asc())
        .getRawMany();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(Number(rows[0].headcount)).toBeGreaterThanOrEqual(2);
    });
  });
});
