/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";

/**
 * A minimal in-memory driver for testing purposes.
 * Does not connect to any database — stores data in Maps.
 * Useful for unit tests that don't need a real DB.
 */
export class InMemoryDriver implements Partial<ISqlDriver> {
  private tables = new Map<string, any[]>();
  private executedQueries: string[] = [];

  async hasTable(name: string): Promise<boolean> {
    return this.tables.has(name);
  }

  async executeRaw(sql: string): Promise<any> {
    this.executedQueries.push(sql);
    return { rows: [] };
  }

  async addPrimaryKey(): Promise<void> {}
  async addAutoIncrement(): Promise<void> {}
  async removePrimaryKey(): Promise<void> {}
  async addNotNull(): Promise<void> {}
  async addColumn(): Promise<void> {}
  async dropColumn(): Promise<void> {}
  async addUniqueConstraint(): Promise<void> {}
  async createTable(): Promise<void> {}
  async dropTable(): Promise<void> {}
  async clear(): Promise<void> {}

  wrapIdentifier(name: string): string {
    return `"${name}"`;
  }

  escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  castType(type: string): string {
    return type.toUpperCase();
  }

  setQueryTimeout(ms: number): string {
    return `-- timeout ${ms}`;
  }

  async acquireAdvisoryLock(): Promise<boolean> {
    return true;
  }

  async releaseAdvisoryLock(): Promise<void> {}

  supportsReturning(): boolean {
    return false;
  }

  /**
   * Get all SQL queries that were executed.
   */
  getExecutedQueries(): string[] {
    return [...this.executedQueries];
  }

  /**
   * Clear recorded queries.
   */
  clearQueries(): void {
    this.executedQueries = [];
  }

  /**
   * Seed a table with test data.
   */
  seedTable(name: string, rows: any[]): void {
    this.tables.set(name, [...rows]);
  }

  /**
   * Get rows from a seeded table.
   */
  getTableData(name: string): any[] {
    return this.tables.get(name) ?? [];
  }
}
