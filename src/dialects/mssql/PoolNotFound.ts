export class PoolNotFound extends Error {
  constructor() {
    super("MSSQL connection pool does not exist.");
  }
}
