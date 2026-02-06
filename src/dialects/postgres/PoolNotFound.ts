export class PoolNotFound extends Error {
  constructor() {
    super("PostgreSQL pool does not exist.");
  }
}
