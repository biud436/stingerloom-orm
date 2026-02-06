export class PostgresConnectionError extends Error {
  constructor() {
    super("PostgreSQL database connection is not established.");
  }
}
