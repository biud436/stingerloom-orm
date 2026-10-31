/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `contains` / `startsWith` / `endsWith` on real servers (MySQL/MariaDB +
 * PostgreSQL): the term's `%`, `_` and `\` match literally under the
 * `ESCAPE '\'` clause the resolver now sends, with the escape character
 * bound as a parameter.
 *
 * SQLite mirror: __tests__/integration/sqlite/where-like-escape.test.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import {
  createTestConnection,
  dropTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const drivers = getTestDrivers();

const TABLE = "wle_dual_file";
const NAMES = ["discount 50% off", "my_file.txt", "myXfile.txt", "back\\slash_here", "plain"];

describe.each(drivers)(
  "[Integration] $label: LIKE helpers escape their term",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let File: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLE })
          class WleDualFile {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
          }
          File = WleDualFile;
          return { entities: [WleDualFile] };
        },
      );
      em = conn.em;
      for (const name of NAMES) await em.save(File, { name });
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(TABLE);
      } catch {
        // ignore
      }
      await conn.cleanup();
    }, 15000);

    async function names(where: Record<string, unknown>): Promise<string[]> {
      const rows: any[] = await em.find(File, { where: { name: where }, orderBy: { id: "ASC" } } as any);
      return rows.map((row) => row.name);
    }

    it("matches %, _ and \\ in the term literally", async () => {
      expect(await names({ contains: "50%" })).toEqual(["discount 50% off"]);
      expect(await names({ contains: "my_file" })).toEqual(["my_file.txt"]);
      expect(await names({ startsWith: "my_" })).toEqual(["my_file.txt"]);
      expect(await names({ endsWith: "_here" })).toEqual(["back\\slash_here"]);
      expect(await names({ contains: "back\\slash" })).toEqual(["back\\slash_here"]);
    });

    it("leaves the raw like operator's wildcards alone", async () => {
      expect(await names({ like: "%my_file%" })).toEqual(["my_file.txt", "myXfile.txt"]);
    });
  },
);
