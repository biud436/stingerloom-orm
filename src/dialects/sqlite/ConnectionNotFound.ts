export class ConnectionNotFound extends Error {
  constructor() {
    super("SQLite connection does not exist.");
  }
}
