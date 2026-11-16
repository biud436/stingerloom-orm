/**
 * An `Error` with an HTTP-style `status`. No ORM error extends it any more:
 * every error the ORM throws is an {@link OrmError} with a `code`. Kept as an
 * export for code that constructs or extends it.
 */
export class Exception extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
