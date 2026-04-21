import { ClazzType } from "../utils";
import { VALIDATION_TOKEN, ValidationMetadata } from "../decorators/Validation";
import { ValidationError } from "../errors/ValidationError";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Performs validation before persisting an entity.
 */
export class EntityValidator {
  /**
   * Validates an entity instance against its metadata.
   * Throws a ValidationError for the first failing constraint.
   */
  static validate<T>(entity: ClazzType<T>, item: Partial<T>): void {
    const validations: ValidationMetadata[] =
      Reflect.getMetadata(VALIDATION_TOKEN, entity) ?? [];

    for (const meta of validations) {
      const value = (item as any)[meta.propertyKey];

      switch (meta.constraint) {
        case "notNull":
          if (value === null || value === undefined) {
            throw new ValidationError(
              meta.propertyKey,
              "notNull",
              meta.message,
              value,
              "non-null value",
            );
          }
          break;

        case "minLength":
          if (typeof value === "string" && value.length < meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "minLength",
              meta.message,
              value.length,
              meta.value,
            );
          }
          break;

        case "maxLength":
          if (typeof value === "string" && value.length > meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "maxLength",
              meta.message,
              value.length,
              meta.value,
            );
          }
          break;

        case "min":
          if (typeof value === "number" && value < meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "min",
              meta.message,
              value,
              meta.value,
            );
          }
          break;

        case "max":
          if (typeof value === "number" && value > meta.value!) {
            throw new ValidationError(
              meta.propertyKey,
              "max",
              meta.message,
              value,
              meta.value,
            );
          }
          break;
      }
    }
  }
}
