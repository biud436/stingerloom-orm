/**
 * New pooled PostgreSQL connections start on the configured `schema`.
 *
 * `find()` reads outside a transaction with an unqualified table name, so
 * it reads whichever schema the connection's search_path names. A table of
 * the same name in `public` holds a decoy row: reading it means the query
 * ran on the server's default search_path.
 *
 * Run:
 *   INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false PG_HOST=<host> \
 *     npx jest --testPathPattern "postgres-connection-search-path"
 *
 * PostgreSQL only: skipped under INTEGRATION_TEST_POSTGRES=false.
 */

import "reflect-metadata";
import { Client } from "pg";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { createTestConnection, TestConnectionResult } from "./helpers/test-connection";
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

/** Runs `sql` on its own connection, outside the ORM's pool. */
async function admin(sql: string): Promise<void> {
  const client = new Client(PG);
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function suffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

const labels = (rows: any[]) => rows.map((row) => row.label);

/**
 * Opens a connection on a new schema holding one row ("kept"), with the
 * decoy table beside it in `public`.
 */
async function openOnOwnSchema(poolMax: number) {
  const schema = `test_conn_sp_${suffix()}`;
  await admin(`CREATE SCHEMA "${schema}"`);
  let note!: DynamicEntityResult;
  const conn: TestConnectionResult = await createTestConnection(
    {
      type: "postgres",
      host: PG.host,
      port: PG.port,
      username: PG.user,
      password: PG.password,
      database: PG.database,
      schema,
      synchronize: true,
      logging: false,
      pool: { max: poolMax },
    } as Partial<DatabaseClientOptions>,
    () => {
      note = createDynamicEntity("conn_sp_note", [
        { name: "id", designType: Number, primary: true },
        { name: "label", designType: String },
      ]);
      return { entities: [note.EntityClass] };
    },
  );
  await admin(`CREATE TABLE public."${note.tableName}" (id serial PRIMARY KEY, label varchar(255))`);
  await admin(`INSERT INTO public."${note.tableName}" (label) VALUES ('decoy')`);
  await conn.em.save(note.EntityClass, { label: "kept" });

  const close = async () => {
    await conn.cleanup();
    await admin(`DROP TABLE IF EXISTS public."${note.tableName}"`);
    await admin(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  };
  return { em: conn.em, note, close };
}

integrationDescribe("[Integration][Postgres] search_path on new pooled connections", () => {
  it("reads the configured schema on every client the pool opens", async () => {
    const { em, note, close } = await openOnOwnSchema(4);
    try {
      // More reads at once than the one idle client: the pool opens the rest.
      const reads = await Promise.all([1, 2, 3, 4].map(() => em.find(note.EntityClass)));

      expect(reads.map(labels)).toEqual([["kept"], ["kept"], ["kept"], ["kept"]]);
    } finally {
      await close();
    }
  }, 30000);

  it("fails the read whose new client the server refused to switch, and runs nothing on it", async () => {
    const { em, note, close } = await openOnOwnSchema(2);
    // The server answers the next SET search_path with an error, on a
    // connection that stays open.
    const original = Client.prototype.query as (...args: any[]) => any;
    let failedClient: unknown;
    const sentAfterFailure: string[] = [];
    const spy = jest
      .spyOn(Client.prototype, "query")
      .mockImplementation(function (this: Client, config: any, ...rest: any[]) {
        const text = typeof config === "string" ? config : config?.text;
        if (!failedClient && typeof text === "string" && text.startsWith("SET search_path")) {
          failedClient = this;
          return original.call(this, "SELECT 1/0", ...rest);
        }
        if (this === failedClient) sentAfterFailure.push(String(text));
        return original.call(this, config, ...rest);
      } as any);
    try {
      // One read takes the idle client; the other opens the failing one.
      const settled = await Promise.allSettled([
        em.find(note.EntityClass),
        em.find(note.EntityClass),
      ]);
      spy.mockRestore();

      expect(failedClient).toBeDefined();
      expect(sentAfterFailure).toEqual([]);
      const fulfilled = settled.flatMap((s) => (s.status === "fulfilled" ? [labels(s.value)] : []));
      const rejected = settled.flatMap((s) => (s.status === "rejected" ? [s.reason] : []));
      expect(fulfilled).toEqual([["kept"]]);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].message)).toContain("division by zero");

      // The pool replaced the client; reads go on in the configured schema.
      const after = await Promise.all([em.find(note.EntityClass), em.find(note.EntityClass)]);
      expect(after.map(labels)).toEqual([["kept"], ["kept"]]);
    } finally {
      spy.mockRestore();
      await close();
    }
  }, 30000);
});
