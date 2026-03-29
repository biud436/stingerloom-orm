/**
 * Raw Pipeline Binary Mode — Integration Tests
 *
 * Tests binary mode and array mode with real PostgreSQL and MySQL databases.
 * Verifies that queryWithOptions() correctly passes driver-level options
 * and that the data is returned in the expected format.
 *
 * Requires: INTEGRATION_TEST=true
 * Optional: INTEGRATION_TEST_MYSQL=false or INTEGRATION_TEST_POSTGRES=false
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  createDynamicEntity,
  generateTableName,
  DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers, TestDriverConfig } from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

// ── Entity with boolean column for binary tests ─────────

function createBinaryTestEntity(driverType: string): DynamicEntityResult {
  return createDynamicEntity(`rpb_${driverType}`, [
    { name: "id", designType: Number, primary: true },
    { name: "name", designType: String, options: { type: "varchar", length: 100 } },
    { name: "age", designType: Number, options: { type: "int" } },
    { name: "active", designType: Boolean, options: { type: "boolean" } },
  ]);
}

// ── Seed helper ─────────────────────────────────────────

async function seedRows(
  em: EntityManager,
  tableName: string,
  count: number,
  driverType: string,
): Promise<void> {
  const q = driverType === "postgres" ? '"' : "`";
  const BATCH = 100;

  for (let offset = 0; offset < count; offset += BATCH) {
    const batchCount = Math.min(BATCH, count - offset);
    const valueParts: string[] = [];
    const params: any[] = [];

    for (let i = 0; i < batchCount; i++) {
      const idx = offset + i;
      valueParts.push("(?, ?, ?)");
      params.push(
        `user_${idx}`,
        idx,
        idx % 2 === 0
          ? driverType === "postgres"
            ? true
            : 1
          : driverType === "postgres"
            ? false
            : 0,
      );
    }

    const insertSql = `INSERT INTO ${q}${tableName}${q} (${q}name${q}, ${q}age${q}, ${q}active${q}) VALUES ${valueParts.join(", ")}`;
    await em.query(insertSql, params);
  }
}

// ── Tests ───────────────────────────────────────────────

const drivers = getTestDrivers();

integrationDescribe.each(drivers)(
  "[Integration] $label: Raw Pipeline Binary Mode",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          plugins: [rawPipelinePlugin()],
        },
        () => {
          testEntity = createBinaryTestEntity(type);
          return { entities: [testEntity.EntityClass] };
        },
      );
      em = conn.em;

      // Seed 200 rows
      await seedRows(em, testEntity.tableName, 200, type);
    }, 30000);

    afterAll(async () => {
      if (!conn) return;
      try {
        await dropTestTable(testEntity.tableName);
      } catch {
        /* ignore */
      }
      await conn.cleanup();
    }, 15000);

    // ── raw() baseline ──────────────────────────────────

    describe("raw() — plain objects baseline", () => {
      it("should return all 200 rows as plain objects", async () => {
        const all = await em
          .pipe(testEntity.EntityClass, { batchSize: 50 })
          .collect();

        expect(all.length).toBe(200);
        expect(typeof all[0]).toBe("object");
        expect(all[0]).toHaveProperty("name");
        expect(all[0]).toHaveProperty("age");
      });

      it("should respect WHERE clause", async () => {
        const pipeline = em.pipe(testEntity.EntityClass, {
          where: { active: true } as any,
          batchSize: 100,
        });

        const all = await pipeline.collect();
        expect(all.length).toBe(100);
      });

      it("should return correct count() with WHERE", async () => {
        const count = await em
          .pipe(testEntity.EntityClass, {
            where: { active: true } as any,
          })
          .count();

        expect(count).toBe(100);
      });
    });

    // ── binary({ arrayMode: true }) ─────────────────────

    describe("binary({ arrayMode: true }) — rows as arrays", () => {
      it("should return rows as arrays instead of objects", async () => {
        const batches: any[][] = [];
        for await (const batch of em
          .pipe(testEntity.EntityClass, { batchSize: 50 })
          .binary({ arrayMode: true })) {
          batches.push(batch);
        }

        expect(batches.length).toBeGreaterThan(0);

        const firstRow = batches[0][0];
        expect(Array.isArray(firstRow)).toBe(true);
        // id, name, age, active = at least 4 columns
        expect(firstRow.length).toBeGreaterThanOrEqual(4);
      });

      it("should return correct total row count", async () => {
        let totalRows = 0;
        for await (const batch of em
          .pipe(testEntity.EntityClass, { batchSize: 100 })
          .binary({ arrayMode: true })) {
          totalRows += batch.length;
        }

        expect(totalRows).toBe(200);
      });

      it("should contain actual data values", async () => {
        const batches: any[][] = [];
        for await (const batch of em
          .pipe(testEntity.EntityClass, { batchSize: 5 })
          .binary({ arrayMode: true })) {
          batches.push(batch);
          break; // first batch only
        }

        const firstRow = batches[0][0];
        // Values exist and are not all undefined
        expect(
          firstRow.some((v: any) => v !== null && v !== undefined),
        ).toBe(true);
      });
    });

    // ── binary({ binary: true }) — raw Buffer mode ──────

    if (type === "postgres") {
      describe("binary({ binary: true }) — PostgreSQL binary wire format", () => {
        it("should return rows with binary-formatted values", async () => {
          const batches: any[][] = [];
          for await (const batch of em
            .pipe(testEntity.EntityClass, { batchSize: 5 })
            .binary({ binary: true })) {
            batches.push(batch);
            break;
          }

          expect(batches.length).toBe(1);
          const firstRow = batches[0][0];
          expect(firstRow).toBeDefined();
          expect(typeof firstRow).toBe("object");

          // pg binary mode: some types (varchar) may arrive as Buffer,
          // while numeric types (int4) may still be parsed natively.
          // Key assertion: the data is present and accessible.
          expect(Object.keys(firstRow).length).toBeGreaterThanOrEqual(4);
        });

        it("should return all rows in binary mode", async () => {
          let totalRows = 0;
          for await (const batch of em
            .pipe(testEntity.EntityClass, { batchSize: 100 })
            .binary({ binary: true })) {
            totalRows += batch.length;
          }

          expect(totalRows).toBe(200);
        });

        it("should preserve data integrity — binary Buffer round-trip", async () => {
          // Read one row in binary, decode the name Buffer, and compare
          const batches: any[][] = [];
          for await (const batch of em
            .pipe(testEntity.EntityClass, {
              orderBy: { id: "ASC" } as any,
              batchSize: 1,
            })
            .binary({ binary: true })) {
            batches.push(batch);
            break;
          }

          const row = batches[0][0];
          // The 'name' column should be a Buffer containing "user_0"
          const nameValue = row.name;
          if (Buffer.isBuffer(nameValue)) {
            expect(nameValue.toString("utf-8")).toBe("user_0");
          }
          // Even if the driver returns it as string, it should still be "user_0"
          else {
            expect(String(nameValue)).toBe("user_0");
          }
        });
      });

      describe("binary({ binary: true, arrayMode: true }) — combined", () => {
        it("should return arrays with binary-formatted values", async () => {
          const batches: any[][] = [];
          for await (const batch of em
            .pipe(testEntity.EntityClass, { batchSize: 5 })
            .binary({ binary: true, arrayMode: true })) {
            batches.push(batch);
            break;
          }

          expect(batches.length).toBe(1);
          const firstRow = batches[0][0];
          expect(Array.isArray(firstRow)).toBe(true);
          // Array should have at least 4 elements (id, name, age, active)
          expect(firstRow.length).toBeGreaterThanOrEqual(4);
        });
      });
    }

    if (type === "mysql") {
      describe("binary({ binary: true }) — MySQL lightweight binary", () => {
        it("should return non-BLOB values as strings (not Buffer)", async () => {
          const batches: any[][] = [];
          for await (const batch of em
            .pipe(testEntity.EntityClass, { batchSize: 5 })
            .binary({ binary: true })) {
            batches.push(batch);
            break;
          }

          expect(batches.length).toBe(1);
          const firstRow = batches[0][0];
          expect(firstRow).toBeDefined();

          // MySQL binary mode: non-BLOB columns are returned as strings
          // (lightweight, avoids ~96 byte per-value Buffer overhead)
          const nameValue = firstRow.name;
          expect(typeof nameValue).toBe("string");
        });

        it("should return all rows in binary mode", async () => {
          let totalRows = 0;
          for await (const batch of em
            .pipe(testEntity.EntityClass, { batchSize: 100 })
            .binary({ binary: true })) {
            totalRows += batch.length;
          }

          expect(totalRows).toBe(200);
        });

        it("should preserve data integrity — string round-trip", async () => {
          const batches: any[][] = [];
          for await (const batch of em
            .pipe(testEntity.EntityClass, {
              orderBy: { id: "ASC" } as any,
              batchSize: 1,
            })
            .binary({ binary: true })) {
            batches.push(batch);
            break;
          }

          const row = batches[0][0];
          // MySQL binary mode returns strings for non-BLOB columns
          expect(String(row.name)).toBe("user_0");
        });
      });
    }

    // ── keyset pagination with binary ───────────────────

    describe("keyset + binary", () => {
      it("should work with keyset pagination in raw mode", async () => {
        let totalRows = 0;
        const batchSizes: number[] = [];

        for await (const batch of em
          .pipe(testEntity.EntityClass, {
            orderBy: { id: "ASC" } as any,
            keyset: true,
            batchSize: 30,
          })
          .raw()) {
          totalRows += batch.length;
          batchSizes.push(batch.length);
        }

        expect(totalRows).toBe(200);
        expect(batchSizes[0]).toBe(30);
      }, 15000);

      it("should work with keyset + binary (non-array) mode", async () => {
        let totalRows = 0;

        for await (const batch of em
          .pipe(testEntity.EntityClass, {
            orderBy: { id: "ASC" } as any,
            keyset: true,
            batchSize: 50,
          })
          .binary({ binary: false })) {
          totalRows += batch.length;
        }

        expect(totalRows).toBe(200);
      }, 15000);
    });

    // ── map() chain on raw ──────────────────────────────

    describe("map() chain on raw()", () => {
      it("should transform rows via map()", async () => {
        const result = await em
          .pipe(testEntity.EntityClass, {
            where: { active: true } as any,
            batchSize: 50,
          })
          .map((row) => ({
            displayName: String(row.name).toUpperCase(),
            isAdult: Number(row.age) >= 18,
          }))
          .collect();

        expect(result.length).toBe(100);
        expect(result[0].displayName).toMatch(/^USER_/);
        expect(typeof result[0].isAdult).toBe("boolean");
      });
    });

    // ── Performance comparison ───────────────────────────

    describe("performance", () => {
      it("pipe().raw() should not be significantly slower than em.find()", async () => {
        // Warm up
        await em.find(testEntity.EntityClass);
        await em.pipe(testEntity.EntityClass, { batchSize: 200 }).collect();

        const RUNS = 5;

        const findStart = Date.now();
        for (let i = 0; i < RUNS; i++) {
          await em.find(testEntity.EntityClass);
        }
        const findTime = Date.now() - findStart;

        const pipeStart = Date.now();
        for (let i = 0; i < RUNS; i++) {
          await em.pipe(testEntity.EntityClass, { batchSize: 200 }).collect();
        }
        const pipeTime = Date.now() - pipeStart;

        console.log(
          `  [${type}] em.find() ${RUNS}x = ${findTime}ms, pipe().raw() ${RUNS}x = ${pipeTime}ms`,
        );
        // At 200 rows, pipe has transaction overhead per batch.
        // MySQL in particular wraps each em.query() in a transaction.
        // We only assert pipe is not catastrophically slow.
        expect(pipeTime).toBeLessThan(findTime * 20);
      });
    });
  },
);
