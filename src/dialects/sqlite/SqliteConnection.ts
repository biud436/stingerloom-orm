import type Database from "better-sqlite3";
import { IConnection } from "../IConnection";

/**
 * SQLite IConnection implementation wrapping a better-sqlite3 Database instance.
 *
 * SQLite uses a single connection (no pool), so release() is a no-op.
 * The connection remains alive as long as the database file is open.
 */
export class SqliteConnection implements IConnection<Database.Database> {
  public readonly acquiredAt: number;
  private released = false;

  constructor(private readonly raw: Database.Database) {
    this.acquiredAt = Date.now();
  }

  getUnderlying(): Database.Database {
    return this.raw;
  }

  async release(): Promise<void> {
    // SQLite has a single connection — release is a no-op
    this.released = true;
  }

  isAlive(): boolean {
    if (this.released) return false;
    return this.raw.open;
  }
}
