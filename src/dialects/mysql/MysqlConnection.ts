import type { PoolConnection } from "mysql2";
import { IConnection } from "../IConnection";
import { readInternalFlag } from "../connection-liveness";

/**
 * MySQL IConnection implementation wrapping a mysql2 PoolConnection.
 */
export class MysqlConnection implements IConnection<PoolConnection> {
  public readonly acquiredAt: number;
  private released = false;

  constructor(private readonly raw: PoolConnection) {
    this.acquiredAt = Date.now();
  }

  getUnderlying(): PoolConnection {
    return this.raw;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.raw.release();
  }

  isAlive(): boolean {
    if (this.released) return false;
    // Undocumented mysql2 internal — probed via connection-liveness.ts only.
    return !readInternalFlag(this.raw, "destroyed");
  }
}
