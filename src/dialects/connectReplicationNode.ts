import type { IConnector } from "../core/IConnector";
import type { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import type { ReplicationNodeConfig } from "./ReplicationRouter";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Throws unless `type` is a database that read replicas can route to.
 */
export function assertReplicationSupported(type: string | undefined): void {
  if (type === "postgres" || type === "mysql" || type === "mariadb") return;
  throw new OrmError(
    OrmErrorCode.UNSUPPORTED_DATABASE,
    `Read replicas are not supported for database type '${type}'.`,
    "Remove the 'replication' option, or use PostgreSQL, MySQL or MariaDB",
  );
}

/**
 * Opens a connection pool to one replication node. The pool takes the
 * connection's own options with the node's host, port, credentials and
 * database, and the node's `ssl` when it sets one. A connector that fails to
 * connect is closed before the error propagates.
 */
export async function connectReplicationNode(
  type: string | undefined,
  options: DatabaseClientOptions,
  node: ReplicationNodeConfig,
): Promise<IConnector> {
  assertReplicationSupported(type);

  let connector: IConnector;
  if (type === "postgres") {
    const { PostgresConnector } = await import("./postgres/PostgresConnector");
    connector = new PostgresConnector();
  } else {
    const { MySqlConnector } = await import("./mysql/MySqlConnector");
    connector = new MySqlConnector();
  }

  try {
    await connector.connect({
      ...options,
      host: node.host,
      port: node.port,
      username: node.username,
      password: node.password,
      database: node.database,
      ...(node.ssl !== undefined ? { ssl: node.ssl } : {}),
    } as DatabaseClientOptions);
  } catch (error) {
    try {
      await connector.close();
    } catch {
      // The connect error is the one to report.
    }
    throw error;
  }
  return connector;
}
