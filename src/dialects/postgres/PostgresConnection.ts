import type { PoolClient } from "pg";
import { IConnection } from "../IConnection";

/**
 * PostgreSQL IConnection implementation wrapping a pg PoolClient.
 */
export class PostgresConnection implements IConnection<PoolClient> {
  public readonly acquiredAt: number;
  private released = false;

  constructor(private readonly raw: PoolClient) {
    this.acquiredAt = Date.now();
  }

  getUnderlying(): PoolClient {
    return this.raw;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.raw.release();
  }

  isAlive(): boolean {
    if (this.released) return false;
    // pg PoolClient has an internal _ending flag when released
    return !(this.raw as unknown as { _ending?: boolean })._ending;
  }
}
