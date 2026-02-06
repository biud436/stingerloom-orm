export class ConnectionNotFound extends Error {
  constructor() {
    super("PostgreSQL connection does not exist.");
  }
}
