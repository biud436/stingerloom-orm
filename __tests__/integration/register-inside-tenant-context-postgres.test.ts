/**
 * Registering an EntityManager from inside `MetadataContext.run(tenant)` on
 * PostgreSQL: the entities' tables are created in the connection's schema,
 * not in the tenant's, whichever tenant strategy is configured.
 *
 * PostgreSQL only: skipped when INTEGRATION_TEST_POSTGRES=false.
 */

import "reflect-metadata";
import { Client } from "pg";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { DatabaseClient } from "../../src/DatabaseClient";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { createDynamicEntity, DynamicEntityResult } from "./helpers/create-test-entity";

const INTEGRATION =
  process.env.INTEGRATION_TEST === "true" &&
  process.env.INTEGRATION_TEST_POSTGRES !== "false";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

const PG = {
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

function suffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

for (const strategy of ["search_path", "schema_qualified"] as const) {
  integrationDescribe(`[Integration][Postgres] registering inside a tenant context (${strategy})`, () => {
    const tenant = `test_ritc_${strategy === "search_path" ? "sp" : "sq"}_${suffix()}`;
    let client: Client;
    let item: DynamicEntityResult;
    let em: EntityManager;

    async function schemasOf(table: string): Promise<string[]> {
      const { rows } = await client.query(
        "SELECT schemaname FROM pg_tables WHERE tablename = $1 ORDER BY schemaname",
        [table],
      );
      return rows.map((r: { schemaname: string }) => r.schemaname);
    }

    beforeAll(async () => {
      client = new Client(PG);
      await client.connect();
      // The tenant's schema exists, so a statement routed there would succeed.
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${tenant}"`);

      MetadataLayerRegistry.reset();
      resetScannerContainer();
      item = createDynamicEntity("ritc_item", [
        { name: "id", designType: Number, primary: true },
        { name: "label", designType: String },
      ]);

      em = new EntityManager();
      await MetadataContext.run(tenant, () =>
        em.register({
          type: "postgres",
          host: PG.host,
          port: PG.port,
          username: PG.user,
          password: PG.password,
          database: PG.database,
          synchronize: true,
          logging: false,
          tenantStrategy: strategy,
          entities: [item.EntityClass],
        } as DatabaseClientOptions),
      );
    }, 30000);

    afterAll(async () => {
      await DatabaseClient.getInstance().close();
      await client.query(`DROP TABLE IF EXISTS public."${item.tableName}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${tenant}" CASCADE`);
      await client.end();
      MetadataContext.reset();
    }, 15000);

    it("creates the table in the connection's schema only", async () => {
      expect(await schemasOf(item.tableName)).toEqual(["public"]);
    });

    it("writes and reads through the EntityManager it registered", async () => {
      await em.save(item.EntityClass, { label: "first" });

      const rows = await em.find(item.EntityClass, {});
      expect(rows.map((r: any) => r.label)).toEqual(["first"]);
    });
  });
}
