/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "../../utils/sqlTag";
import { IConnector } from "../../core/IConnector";
import { IDataSource } from "../IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { PostgresConnectionError } from "./PostgresConnectionError";
import { PostgresConnector } from "./PostgresConnector";
import { MetadataContext } from "../../metadata/MetadataContext";
import { validateSavepointName } from "../../utils/validateSavepointName";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";
import { pgQueryWithOptions } from "./pgQueryWithOptions";

export class PostgresDataSource implements IDataSource {
  private connection?: any;
  /**
   * The schema the open transaction's search_path names — `null` while that
   * is unknown — or `undefined` when this session does not follow it: no
   * transaction, or a tenant strategy that leaves search_path alone.
   */
  private searchPath?: string | null;
  /** The search_path at each open savepoint, which ROLLBACK TO brings back. */
  private savepointPaths: Array<{ name: string; searchPath: string | null }> = [];
  /** Settles once the statements queued behind a search_path switch have run. */
  private queue?: Promise<void>;

  constructor(private readonly connector: IConnector) {}

  async createConnection() {
    this.connection = await this.connector.getConnection();

    if (!this.connection) {
      throw new PostgresConnectionError();
    }
  }

  async close() {
    if (!this.connection) {
      return;
    }

    try {
      this.connection.release();
    } catch {
      // Ignore if the connection was already released
    }
    this.connection = undefined;
    this.endTransaction();
  }

  async startTransaction(level?: TRANSACTION_ISOLATION_LEVEL) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    await this.connector.startTransaction(this.connection, level);
    // The connector pointed search_path at the tenant active at BEGIN.
    this.searchPath =
      this.connector instanceof PostgresConnector
        ? this.connector.searchPathFor(MetadataContext.getCurrentTenant())
        : undefined;
    this.savepointPaths = [];
  }

  async rollback() {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    if (this.queue) await this.queue;
    try {
      await this.connector.rollback(this.connection);
    } finally {
      // PostgresConnector.rollback() always releases the client (destructively
      // on failure), so clear the reference even when the connector throws —
      // otherwise a later close() would attempt a double release.
      this.connection = undefined;
      this.endTransaction();
    }
  }

  async commit() {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    if (this.queue) await this.queue;
    try {
      await this.connector.commit(this.connection);
    } finally {
      // PostgresConnector.commit() always releases the client (destructively
      // on failure), so clear the reference even when the connector throws.
      this.connection = undefined;
      this.endTransaction();
    }
  }

  async query(sql: string | Sql) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    return await this.inTenantSchema((client) =>
      this.connector.query(sql as any, client),
    );
  }

  async queryWithOptions(sql: Sql, options: DriverQueryOptions) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    return this.inTenantSchema((client) =>
      pgQueryWithOptions(client, sql, options),
    );
  }

  async savepoint(name: string) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    validateSavepointName(name);
    const escaped = `"${name.replace(/"/g, '""')}"`;
    await this.inOrder((client) => {
      if (this.searchPath !== undefined) {
        this.savepointPaths.push({ name, searchPath: this.searchPath });
      }
      return this.connector.query(`SAVEPOINT ${escaped}`, client);
    });
  }

  async rollbackTo(name: string) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    validateSavepointName(name);
    const escaped = `"${name.replace(/"/g, '""')}"`;
    await this.inOrder(async (client) => {
      const done = this.connector.query(`ROLLBACK TO SAVEPOINT ${escaped}`, client);
      if (this.searchPath !== undefined) {
        // ROLLBACK TO also undoes the SET LOCALs issued since the savepoint.
        let index = this.savepointPaths.length - 1;
        while (index >= 0 && this.savepointPaths[index].name !== name) index--;
        if (index >= 0) {
          this.searchPath = this.savepointPaths[index].searchPath;
          this.savepointPaths.length = index + 1;
        } else {
          this.searchPath = null;
        }
      }
      try {
        return await done;
      } catch (e) {
        if (this.searchPath !== undefined) this.searchPath = null;
        throw e;
      }
    });
  }

  /**
   * Runs `statement` under the search_path of the tenant active when it is
   * issued. The transaction's `SET LOCAL search_path` names the tenant that
   * began it, so work for another one inside it — a nested
   * `MetadataContext.run()`, or a transaction begun before any tenant was
   * set — first points search_path at that tenant's schema. Statements issued
   * while such a switch is under way queue behind it: each still runs under
   * its own tenant's schema when several are in flight.
   */
  private inTenantSchema<T>(statement: (client: any) => Promise<T>): Promise<T> {
    if (this.searchPath === undefined) return statement(this.connection);
    const connector = this.connector as PostgresConnector;
    const schema = connector.searchPathFor(MetadataContext.getCurrentTenant());
    if (!this.queue && schema === this.searchPath) {
      return statement(this.connection);
    }
    return this.enqueue(async () => {
      const client = this.openConnection();
      if (schema !== undefined && schema !== this.searchPath) {
        this.searchPath = null;
        await connector.setLocalSearchPath(client, schema);
        this.searchPath = schema;
      }
      return statement(client);
    });
  }

  /** Runs `work` after the statements already queued, if any. */
  private inOrder<T>(work: (client: any) => Promise<T>): Promise<T> {
    if (!this.queue) return work(this.connection);
    return this.enqueue(() => work(this.openConnection()));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const turn = (this.queue ?? Promise.resolve()).then(work);
    const settled = turn.then(
      () => undefined,
      () => undefined,
    );
    this.queue = settled;
    void settled.then(() => {
      if (this.queue === settled) this.queue = undefined;
    });
    return turn;
  }

  private openConnection(): any {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }
    return this.connection;
  }

  private endTransaction(): void {
    this.searchPath = undefined;
    this.savepointPaths = [];
    this.queue = undefined;
  }
}
