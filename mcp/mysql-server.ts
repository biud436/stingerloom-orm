import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import { z } from "zod";

const pool = mysql.createPool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? "fastify",
  user: process.env.DB_USER ?? "admin",
  password: process.env.MYSQL_PWD ?? process.env.DB_PASSWORD ?? "",
  waitForConnections: true,
  connectionLimit: 5,
});

const server = new McpServer({
  name: "mysql",
  version: "1.0.0",
});

server.tool("query", "Execute a SQL query against the MySQL database", { sql: z.string().describe("SQL query to execute") }, async ({ sql }) => {
  try {
    const [rows] = await pool.query(sql);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("list_tables", "List all tables in the current database", {}, async () => {
  try {
    const [rows] = await pool.query("SHOW TABLES");
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("describe_table", "Show column details for a table", { table: z.string().describe("Table name") }, async ({ table }) => {
  try {
    const [rows] = await pool.query(`DESCRIBE \`${table.replace(/`/g, "``")}\``);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.tool("list_databases", "List all databases on the server", {}, async () => {
  try {
    const [rows] = await pool.query("SHOW DATABASES");
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
