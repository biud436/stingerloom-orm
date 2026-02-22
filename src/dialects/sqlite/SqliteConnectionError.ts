export class SqliteConnectionError extends Error {
  constructor() {
    super("SQLite database connection is not established.");
  }
}
