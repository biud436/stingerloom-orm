export class ConnectionNotFound extends Error {
  constructor() {
    super("MSSQL connection does not exist.");
  }
}
