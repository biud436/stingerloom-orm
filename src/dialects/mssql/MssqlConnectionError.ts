export class MssqlConnectionError extends Error {
  constructor() {
    super("MSSQL database connection is not established.");
  }
}
