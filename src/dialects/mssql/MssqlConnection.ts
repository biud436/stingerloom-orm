import type { ConnectionPool } from "mssql";
import { IConnection } from "../IConnection";

/**
 * MSSQL IConnection implementation wrapping an mssql ConnectionPool.
 *
 * MSSQL manages connections internally via its ConnectionPool. The pool itself
 * is the "connection" that we hand around. release() is a no-op because the
 * pool handles connection lifecycle internally.
 */
export class MssqlConnection implements IConnection<ConnectionPool> {
  public readonly acquiredAt: number;
  private released = false;

  constructor(private readonly raw: ConnectionPool) {
    this.acquiredAt = Date.now();
  }

  getUnderlying(): ConnectionPool {
    return this.raw;
  }

  async release(): Promise<void> {
    // MSSQL ConnectionPool manages connections internally
    this.released = true;
  }

  isAlive(): boolean {
    if (this.released) return false;
    return this.raw.connected;
  }
}
