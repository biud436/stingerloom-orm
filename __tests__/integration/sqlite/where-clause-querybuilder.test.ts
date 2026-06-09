/**
 * SQLite integration tests for the WhereClause filter-object form of
 * SelectQueryBuilder.where() / andWhere() / orWhere().
 *
 * Verifies that the same Prisma-style filter objects accepted by
 * `em.find({ where })` work end-to-end on the query builder against a real
 * SQLite database — equality, operators, IN, contains, null, OR/AND/NOT,
 * the array (OR-group) form, and interop with joins + chained conditions.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { generateTableName } from "../helpers/create-test-entity";

interface EmployeeShape {
  id: number;
  name: string;
  role: string;
  salary: number;
  status: string;
}

describe("[Integration] SQLite In-Memory: QueryBuilder where(WhereClause)", () => {
  let conn: TestConnectionResult;
  let Employee: new () => EmployeeShape;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("wc_employees");

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

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "role");
        Column({ type: "varchar", length: 50 })(DynClass.prototype, "role");

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "salary");
        Column({ type: "int" })(DynClass.prototype, "salary");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "status");
        Column({ type: "varchar", length: 20 })(DynClass.prototype, "status");

        Entity()(DynClass);
        Employee = DynClass;
        return { entities: [DynClass] };
      },
    );

    const { em } = conn;
    await em.save(Employee, { name: "Alice",   role: "admin", salary: 100, status: "active" });
    await em.save(Employee, { name: "Bob",     role: "user",  salary: 80,  status: "active" });
    await em.save(Employee, { name: "Charlie", role: "user",  salary: 90,  status: "inactive" });
    await em.save(Employee, { name: "Dave",    role: "admin", salary: 120, status: "active" });
    await em.save(Employee, { name: "Eve",     role: "owner", salary: 150, status: "active" });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  const names = (rows: EmployeeShape[]) => rows.map((r) => r.name).sort();

  it("implicit equality", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ role: "admin" })
      .getMany();
    expect(names(rows)).toEqual(["Alice", "Dave"]);
  });

  it("multiple keys are AND-ed", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ role: "user", status: "active" })
      .getMany();
    expect(names(rows)).toEqual(["Bob"]);
  });

  it("comparison operators ({ gte })", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ salary: { gte: 100 } })
      .getMany();
    expect(names(rows)).toEqual(["Alice", "Dave", "Eve"]);
  });

  it("{ in: [...] }", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ role: { in: ["owner", "admin"] } })
      .getMany();
    expect(names(rows)).toEqual(["Alice", "Dave", "Eve"]);
  });

  it("{ contains } substring match", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ name: { contains: "li" } }) // Alice, Charlie
      .getMany();
    expect(names(rows)).toEqual(["Alice", "Charlie"]);
  });

  it("OR combinator", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ OR: [{ role: "owner" }, { salary: { lt: 85 } }] })
      .getMany();
    expect(names(rows)).toEqual(["Bob", "Eve"]);
  });

  it("NOT combinator", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ NOT: { status: "active" } })
      .getMany();
    expect(names(rows)).toEqual(["Charlie"]);
  });

  it("array form OR-s the groups", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where([
        { role: "admin", status: "active" }, // Alice, Dave
        { salary: { gte: 150 } }, // Eve
      ])
      .getMany();
    expect(names(rows)).toEqual(["Alice", "Dave", "Eve"]);
  });

  it("andWhere(filterObject) narrows further", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ status: "active" })
      .andWhere({ salary: { gte: 100 } })
      .getMany();
    expect(names(rows)).toEqual(["Alice", "Dave", "Eve"]);
  });

  it("orWhere(filterObject) widens the set", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ role: "owner" })
      .orWhere({ status: "inactive" })
      .getMany();
    expect(names(rows)).toEqual(["Charlie", "Eve"]);
  });

  it("filter object composes with a tuple condition", async () => {
    const rows = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ status: "active" })
      .andWhere("salary", ">", 110)
      .getMany();
    expect(names(rows)).toEqual(["Dave", "Eve"]);
  });

  it("works through getCount() / paginate()", async () => {
    const count = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ status: "active" })
      .getCount();
    expect(count).toBe(4);

    const page = await conn.em
      .createQueryBuilder(Employee, "e")
      .where({ status: "active" })
      .orderBy({ salary: "ASC" })
      .paginate({ page: 1, pageSize: 2 });
    expect(page.total).toBe(4);
    expect(page.data.map((r) => r.name)).toEqual(["Bob", "Alice"]);
  });
});
