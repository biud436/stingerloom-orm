
/* eslint-disable @typescript-eslint/no-explicit-any */
export const VALIDATION_TOKEN = Symbol.for("STG_VALIDATION");

export type ConstraintType =
  | "notNull"
  | "minLength"
  | "maxLength"
  | "min"
  | "max";

export type ValidationMetadata = {
  propertyKey: string;
  constraint: ConstraintType;
  value?: number;
  message: string;
};

function addValidation(
  target: object,
  propertyKey: string,
  metadata: ValidationMetadata,
): void {
  const existing: ValidationMetadata[] =
    Reflect.getMetadata(VALIDATION_TOKEN, target.constructor) ?? [];
  Reflect.defineMetadata(
    VALIDATION_TOKEN,
    [...existing, metadata],
    target.constructor,
  );
}

/**
 * Throws ValidationError if the field is null/undefined.
 */
export function NotNull(): PropertyDecorator {
  return (target, propertyKey) => {
    addValidation(target, propertyKey.toString(), {
      propertyKey: propertyKey.toString(),
      constraint: "notNull",
      message: `${propertyKey.toString()} must not be null or undefined`,
    });
  };
}

/**
 * Checks the minimum length of a string field.
 */
export function MinLength(min: number): PropertyDecorator {
  return (target, propertyKey) => {
    addValidation(target, propertyKey.toString(), {
      propertyKey: propertyKey.toString(),
      constraint: "minLength",
      value: min,
      message: `${propertyKey.toString()} must be at least ${min} characters long`,
    });
  };
}

/**
 * Checks the maximum length of a string field.
 */
export function MaxLength(max: number): PropertyDecorator {
  return (target, propertyKey) => {
    addValidation(target, propertyKey.toString(), {
      propertyKey: propertyKey.toString(),
      constraint: "maxLength",
      value: max,
      message: `${propertyKey.toString()} must be at most ${max} characters long`,
    });
  };
}

/**
 * Checks the minimum value of a numeric field.
 */
export function Min(min: number): PropertyDecorator {
  return (target, propertyKey) => {
    addValidation(target, propertyKey.toString(), {
      propertyKey: propertyKey.toString(),
      constraint: "min",
      value: min,
      message: `${propertyKey.toString()} must be at least ${min}`,
    });
  };
}

/**
 * Checks the maximum value of a numeric field.
 */
export function Max(max: number): PropertyDecorator {
  return (target, propertyKey) => {
    addValidation(target, propertyKey.toString(), {
      propertyKey: propertyKey.toString(),
      constraint: "max",
      value: max,
      message: `${propertyKey.toString()} must be at most ${max}`,
    });
  };
}
