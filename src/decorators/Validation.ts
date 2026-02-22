import "reflect-metadata";

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
 * 해당 필드가 null/undefined이면 ValidationError를 throw합니다.
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
 * 문자열 필드의 최소 길이를 검사합니다.
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
 * 문자열 필드의 최대 길이를 검사합니다.
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
 * 숫자 필드의 최솟값을 검사합니다.
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
 * 숫자 필드의 최댓값을 검사합니다.
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
