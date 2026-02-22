export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly constraint: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
