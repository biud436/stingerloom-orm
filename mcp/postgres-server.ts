import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

const pool = new pg.Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? "multi_tenancy_db2",
  user: process.env.DB_USER ?? "postgres",
  password: process.env.PGPASSWORD ?? process.env.DB_PASSWORD ?? "postgres",
  max: 5,
});

const server = new McpServer({
  name: "postgres",
  version: "1.0.0",
});

server.tool("query", "Execute a SQL query against the PostgreSQL database", { sql: z.string().describe("SQL query to execute") }, async ({ sql }) => {
  const client = await pool.connect();
  try {
    const result = await client.query(sql);
    return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  } finally {
    client.release();
  }
});

server.tool(
  "list_tables",
  "List all tables in a schema",
  { schema: z.string().optional().default("public").describe("Schema name (default: public)") },
  async ({ schema }) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
        [schema],
      );
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    } finally {
      client.release();
    }
  },
);

server.tool(
  "describe_table",
  "Show column details for a table",
  {
    table: z.string().describe("Table name"),
    schema: z.string().optional().default("public").describe("Schema name (default: public)"),
  },
  async ({ table, schema }) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table],
      );
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    } finally {
      client.release();
    }
  },
);

server.tool("list_schemas", "List all user-defined schemas", {}, async () => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast') ORDER BY schema_name",
    );
    return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  } finally {
    client.release();
  }
});

server.tool("list_databases", "List all databases on the server", {}, async () => {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
    return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  } finally {
    client.release();
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
