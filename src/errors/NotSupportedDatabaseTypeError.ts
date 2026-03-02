import { Exception } from "./Exception";

export class NotSupportedDatabaseTypeError extends Exception {
  constructor() {
    super("Unsupported database type.", 500);
  }
}
